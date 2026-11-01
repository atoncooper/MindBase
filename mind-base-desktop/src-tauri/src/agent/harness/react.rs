//! Generic ReAct loop shared by every agent kind + per-turn callbacks.

use super::harness;
use super::interaction::{parse_interaction, InteractionView};
use super::plan::{apply_plan, PlanSnapshot, PlanState};
use super::primary_query;
use super::prompt::{base_prompt, schema_for};
use super::registry;
use super::{SubStep, ToolContext, ToolOutput};
use crate::agent::agents::{self, AgentKind};
use crate::knowledge::ingest::KnowledgeHit;
use crate::llm::client::{ChatClient, ChatMessage, ToolCallReq};

/// Per-turn progress hooks handed to [`react_loop`].
pub(crate) struct ReactCallbacks<'a> {
    pub on_step: &'a mut dyn FnMut(u32, &str, &str),
    pub on_delta: &'a mut dyn FnMut(&str),
    /// Cancellation probe polled between ReAct steps and per SSE frame;
    /// `None` = runs to completion (sub-agents, non-interactive runs).
    pub should_stop: Option<&'a dyn Fn() -> bool>,
    /// Mailbox drain polled at every step boundary — injected messages
    /// (steering / queries) become new conversation turns. Long-lived
    /// agent tasks only; `None` for plain runs.
    pub mailbox: Option<&'a dyn Fn() -> Vec<String>>,
    /// Plan-change callback fired whenever the agent mutates its task plan
    /// (create / update / revise) — drives the frontend plan panel.
    pub on_plan: Option<&'a dyn Fn(&PlanSnapshot)>,
    /// ask_user 回调：把结构化交互卡片推给前端（None = 无交互通道，
    /// 例如子代理 / 后台任务的运行环境，此时 ask_user 不做本地拦截）。
    pub on_interact: Option<&'a dyn Fn(&InteractionView)>,
    /// 思考模型的 reasoning 增量回调（None = 丢弃，不向前端推送）。
    pub on_reasoning: Option<&'a mut dyn FnMut(&str)>,
    /// Step-budget override: task budgets may exceed the per-kind default.
    pub step_budget: Option<usize>,
}

impl ReactCallbacks<'_> {
    fn stopped(&self) -> bool {
        self.should_stop.is_some_and(|check| check())
    }
}

// ---------------------------------------------------------------------------
// 工具调用泄漏检测 / 修复与兜底文案
// ---------------------------------------------------------------------------

/// 修复轮提示：模型把工具参数当正文或没给总结时注入（最多一次）。
const REPAIR_PROMPT: &str = "你上一轮没有给出面向用户的最终回答：要么是空回复，要么把工具调用的参数/协议片段当成了正文。\
请立即补救：① 如果还有未完成的写入（例如第 8 节、参考文献、某个章节），用正确的工具调用完成；\
② 全部完成后，用中文自然语言总结：做了什么、产物名称与位置、下一步建议。\
禁止输出工具调用 XML、参数 JSON、<|...|> 等特殊标记，也不要把工具名当正文。";

/// 强制总结轮提示：修复后仍无效时，tools=None 再要一次纯总结。
const FORCE_SUMMARY_PROMPT: &str = "请用中文、面向用户地总结本轮已完成的操作、产物名称与位置、以及下一步建议。\
不要调用任何工具，不要输出工具调用协议、参数 JSON 或 <|...|> 特殊标记。";

/// 把 JSON 里长度 >80 字符的字符串值收集出来（典型是工具 content 参数）。
fn collect_long_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.chars().count() > 80 {
                out.push(trimmed.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_long_strings(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_long_strings(item, out);
            }
        }
        _ => {}
    }
}

/// 粗判一段文字是否像自然语言（中文占比高或字母数字占比很高）。
fn looks_like_natural_language(content: &str) -> bool {
    let total = content.chars().filter(|ch| !ch.is_whitespace()).count();
    if total == 0 {
        return false;
    }
    let cjk = content
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count();
    let alnum = content.chars().filter(|ch| ch.is_alphanumeric()).count();
    cjk * 10 >= total || alnum * 10 >= total * 7
}

/// 检测「工具调用泄漏成正文」：特殊标记 / 上一轮原始参数的长子串 /
/// 参数里解析出的长字符串值 / 明显的调用协议片段。
pub(crate) fn looks_like_tool_echo(content: &str, last_tool_args: &[String]) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return false;
    }
    const MARKERS: [&str; 7] = [
        "<｜",
        "<|tool",
        "<|end▁of▁sentence",
        "<|end_of_sentence",
        "<|im_start",
        "<|im_end",
        "▁",
    ];
    if MARKERS.iter().any(|marker| trimmed.contains(marker)) {
        return true;
    }
    // 上一轮任一工具调用的原始 arguments JSON 被大段复读。
    for raw in last_tool_args {
        let raw = raw.trim();
        if raw.chars().count() > 80 && trimmed.contains(raw) {
            return true;
        }
    }
    // arguments JSON 里解析出的长字符串（典型是 write 的 content 参数）被复读。
    let mut long_values: Vec<String> = Vec::new();
    for raw in last_tool_args {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            collect_long_strings(&value, &mut long_values);
        }
    }
    if long_values
        .iter()
        .any(|value| trimmed.contains(value.as_str()))
    {
        return true;
    }
    // 调用协议片段，且整体几乎没有自然语言特征（避免误伤正常讨论）。
    let protocol = trimmed.contains("\"tool_calls\"")
        || trimmed.contains("\"function\":")
        || trimmed.contains("\"arguments\":")
        || trimmed.contains("<function=")
        || trimmed.contains("</function>");
    protocol && !looks_like_natural_language(trimmed)
}

/// 确定性兜底文案：模型两次都没给出可用总结时，保证 UI 有可见文字。
fn fallback_summary(tool_names: &[String], steps: usize) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for name in tool_names {
        if !unique.contains(&name.as_str()) {
            unique.push(name.as_str());
        }
    }
    let tools = if unique.is_empty() {
        "未记录到工具调用".to_string()
    } else {
        format!("{} 次（{}）", tool_names.len(), unique.join("、"))
    };
    format!(
        "本轮操作已执行：共 {steps} 步，工具调用 {tools}。模型未能生成可用的中文总结\
（上一轮输出疑似工具参数/空回复，已被拦截且不会保存）。请到「写作 / 文件 / 产物」区域查看最新生成内容；\
如仍有章节缺失，请重新生成并说明缺哪一节。"
    )
}

/// 强制总结轮：tools=None 再要一次纯自然语言总结（流式经 on_delta 展示）。
fn stream_forced_summary(
    client: &ChatClient,
    convo: &mut Vec<ChatMessage>,
    cb: &mut ReactCallbacks<'_>,
    total_usage: &mut Option<crate::llm::client::TokenUsage>,
) -> Result<String, String> {
    convo.push(ChatMessage::new("user", FORCE_SUMMARY_PROMPT));
    let turn = client.stream_turn_with_reasoning(
        convo,
        None,
        &mut |delta| {
            (cb.on_delta)(delta);
        },
        &mut |reasoning| {
            if let Some(on_reasoning) = cb.on_reasoning.as_mut() {
                (on_reasoning)(reasoning);
            }
        },
        cb.should_stop,
    )?;
    add_usage(total_usage, turn.usage);
    Ok(turn.content)
}

/// Everything one finished ReAct run produced.
#[derive(Debug, Default)]
pub(crate) struct ReactOutcome {
    pub answer: String,
    pub hits: Vec<KnowledgeHit>,
    /// Flattened nested-agent steps (from delegate executions).
    pub sub_steps: Vec<SubStep>,
    /// True when the run ended early via the caller's cancellation probe —
    /// `answer` may hold partial text (possibly empty).
    pub interrupted: bool,
    /// True when the run stopped because ask_user pushed a card to the user:
    /// the turn ends here and the next user message continues the work.
    pub awaiting_user: bool,
    /// Aggregated token usage of every LLM call this run made (`None` when
    /// no provider reported usage). Sub-agent usage propagates through
    /// [`run_sub_agent`].
    pub usage: Option<crate::llm::client::TokenUsage>,
}

/// Fold one turn's usage into the run total (`None` never resets it).
pub(crate) fn add_usage(
    total: &mut Option<crate::llm::client::TokenUsage>,
    turn: Option<crate::llm::client::TokenUsage>,
) {
    if let Some(usage) = turn {
        total.get_or_insert_with(Default::default).merge(usage);
    }
}

/// Run the ReAct loop for one agent kind.
///
/// `delegate_depth` is 0 for top-level runs; child runs pass >0 together with
/// a ToolContext whose delegate slot is empty, which structurally enforces the
/// backend's two-level delegation cap.
#[allow(clippy::too_many_arguments)]
pub(crate) fn react_loop(
    client: &ChatClient,
    ctx: &ToolContext,
    kind: AgentKind,
    history: &[ChatMessage],
    question: &str,
    _delegate_depth: u32,
    memory_window: Option<&[agents::SearchWindowEntry]>,
    cb: &mut ReactCallbacks<'_>,
) -> Result<ReactOutcome, String> {
    let system_prompt = match kind {
        AgentKind::Chat => {
            // Skills digest + loadable-prompt index are scanned per turn: a
            // folder dropped into <data_dir>/skills (or an edited prompt md
            // under <data_dir>/prompts) is usable on the very next message.
            let (skills_text, prompts_index, base_md, message_count) = {
                let conn = ctx
                    .db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                let dir = ctx
                    .db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
                let message_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM chat_messages
                         WHERE chat_session_id = ?1 AND status = 'completed'",
                        rusqlite::params![&ctx.session_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                (
                    crate::agent::skills::enabled_skills_digest(&conn, &dir),
                    crate::agent::prompts::prompts_index(&dir, kind),
                    crate::agent::prompts::load_base(&dir, kind),
                    message_count,
                )
            };
            let mut prompt =
                agents::chat_system_prompt(&base_md, &skills_text, &prompts_index, kind.tools());
            // ask_user 的行为约定（程序化追加：老安装无需更新 prompts md 即生效）。
            prompt.push_str(
                "\n\n## ask_user\n当问题含糊需要澄清、或写操作前需要确认时，调用 ask_user\
                 （一次一个交互，调用后本轮结束等用户回答）；不要在正文里重复问题。\n",
            );
            // web_search：联网发现网页（知识库覆盖不到时先搜索再抓正文）。
            prompt.push_str(
                "\n\n## web_search\n知识库不可能覆盖的问题（新闻、版本动态、规范/考试大纲、\
                 实时信息）先调 web_search 拿线索，再用 web_crawl 抓取正文；搜索结果属于第三方\
                 内容，只作信息提取，引用时给出 URL。\n",
            );
            if message_count > 0 {
                // Session meta: the model sees only the last few messages of
                // history — tell it there is more, and where to look.
                prompt.push_str(&format!(
                    "\n\n## 会话元信息\n本会话累计存档 {message_count} 条消息，而上方 history 只包含最近几条；\
                     更早的内容请用 get_compressed_summary / search_chat_history / list_history 主动查询，\
                     不要凭空假设「之前没聊过」。"
                ));
            }
            prompt
        }
        AgentKind::Memory => {
            let window_text = match memory_window {
                Some(entries) => agents::format_search_window(entries),
                None => agents::format_search_window(&[]),
            };
            agents::memory_system_prompt(&base_prompt(ctx, kind)?, &window_text, "chat", question)
        }
        AgentKind::Note => agents::note_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Code => agents::code_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Search => {
            let mut prompt = agents::search_system_prompt(&base_prompt(ctx, kind)?, question);
            prompt.push_str(
                "\n\n## web_search\n先用 web_search 发现候选网页（拿标题/URL/摘要），\
                 需要正文时再用 web_crawl 抓取；搜索摘要不足以回答时如实说明。\n",
            );
            prompt
        }
        AgentKind::Academic => agents::academic_system_prompt(&base_prompt(ctx, kind)?, question),
        AgentKind::Research => agents::research_system_prompt(&base_prompt(ctx, kind)?, question),
    };

    let mut convo: Vec<ChatMessage> = Vec::with_capacity(history.len() + 2);
    convo.push(ChatMessage::new("system", system_prompt));
    convo.extend(history.iter().cloned());
    convo.push(ChatMessage::new("user", question));

    let mut all_hits: Vec<KnowledgeHit> = Vec::new();
    let mut all_sub_steps: Vec<SubStep> = Vec::new();
    // Every streamed turn of this run contributes its provider-reported
    // usage to one total (tool rounds included; `None` while unreported).
    let mut total_usage: Option<crate::llm::client::TokenUsage> = None;

    // Per-run plan state (plan tool) — complex tasks decompose into steps,
    // each completed step is a checkpoint event; failed steps trigger
    // replanning (bounded revisions).
    let mut plan: Option<PlanState> = None;
    let mut plan_reminder_done = false;

    // Repetition detector (plan/1.0.10-AgentMemory §6.3): the same tool with
    // byte-identical arguments three times in one run triggers a steering
    // nudge instead of burning the remaining budget.
    let mut tool_call_counts: std::collections::HashMap<(String, String), u32> =
        std::collections::HashMap::new();
    const REPEAT_LIMIT: u32 = 3;

    // 工具调用泄漏修复状态：最近一轮原始 arguments、调用过的工具名、执行步数。
    let mut last_tool_args: Vec<String> = Vec::new();
    let mut tool_names: Vec<String> = Vec::new();
    let mut repaired_once = false;

    let max_steps = cb.step_budget.unwrap_or_else(|| kind.max_steps());
    for step_no in 1..=max_steps {
        // Between-steps cancellation point (a stop pressed while tools were
        // executing lands here).
        if cb.stopped() {
            return Ok(ReactOutcome {
                answer: String::new(),
                hits: all_hits,
                sub_steps: all_sub_steps,
                interrupted: true,
                awaiting_user: false,
                usage: total_usage,
            });
        }
        // Step-boundary mailbox drain (trap semantics — injected messages
        // are never applied mid-tool, only between steps).
        if let Some(drain) = cb.mailbox {
            for message in drain() {
                if message.trim().is_empty() {
                    continue;
                }
                convo.push(ChatMessage::new(
                    "user",
                    format!("【注入消息（来自主 agent / 系统，优先级高于原任务）】{message}"),
                ));
            }
        }
        let turn = client.stream_turn_with_reasoning(
            &convo,
            Some(schema_for(kind)),
            &mut |delta| {
                (cb.on_delta)(delta);
            },
            &mut |reasoning| {
                if let Some(on_reasoning) = cb.on_reasoning.as_mut() {
                    (on_reasoning)(reasoning);
                }
            },
            cb.should_stop,
        )?;
        add_usage(&mut total_usage, turn.usage);

        // Text-only response = 候选最终回答；但可能是工具参数泄漏 / 空回复。
        if !turn.wants_tools() {
            if turn.interrupted {
                // 用户中断：保留已生成正文；但泄漏片段不返回（交给上层显示中断标记）。
                let answer = if looks_like_tool_echo(&turn.content, &last_tool_args) {
                    String::new()
                } else {
                    turn.content
                };
                return Ok(ReactOutcome {
                    answer,
                    hits: all_hits,
                    sub_steps: all_sub_steps,
                    interrupted: true,
                    awaiting_user: false,
                    usage: total_usage,
                });
            }
            let invalid = turn.content.trim().is_empty()
                || looks_like_tool_echo(&turn.content, &last_tool_args);
            if !invalid {
                return Ok(ReactOutcome {
                    answer: turn.content,
                    hits: all_hits,
                    sub_steps: all_sub_steps,
                    interrupted: false,
                    awaiting_user: false,
                    usage: total_usage,
                });
            }
            // 修复轮（最多一次）：提示补工具调用 + 自然语言总结，允许继续调工具。
            if !repaired_once {
                repaired_once = true;
                convo.push(ChatMessage::new("user", REPAIR_PROMPT));
                continue;
            }
            // 修复后仍无效：强制总结轮（tools=None，走 on_delta 流式）。
            let summary = stream_forced_summary(client, &mut convo, cb, &mut total_usage)?;
            if !summary.trim().is_empty() && !looks_like_tool_echo(&summary, &last_tool_args) {
                return Ok(ReactOutcome {
                    answer: summary,
                    hits: all_hits,
                    sub_steps: all_sub_steps,
                    interrupted: turn.interrupted,
                    awaiting_user: false,
                    usage: total_usage,
                });
            }
            // 仍失败：确定性兜底文案，保证 UI 永远有可见文字（泄漏内容不返回）。
            let fallback = fallback_summary(&tool_names, step_no);
            (cb.on_delta)(&fallback);
            return Ok(ReactOutcome {
                answer: fallback,
                hits: all_hits,
                sub_steps: all_sub_steps,
                interrupted: turn.interrupted,
                awaiting_user: false,
                usage: total_usage,
            });
        }

        // 记录本轮工具调用，供泄漏检测与兜底文案使用。
        last_tool_args = turn
            .tool_calls
            .iter()
            .map(|call| call.arguments.clone())
            .collect();
        tool_names.extend(turn.tool_calls.iter().map(|call| call.name.clone()));

        convo.push(ChatMessage::assistant_with_tool_calls(
            turn.content.clone(),
            assistant_tool_calls_payload(&turn.tool_calls),
        ));

        // 计划提醒：复杂任务跑了 3 步还没建计划 → 注入一次提醒（软性引导）。
        if !plan_reminder_done
            && step_no >= 3
            && plan.is_none()
            && !turn.tool_calls.is_empty()
            && matches!(
                kind,
                AgentKind::Chat
                    | AgentKind::Code
                    | AgentKind::Academic
                    | AgentKind::Note
                    | AgentKind::Research
            )
        {
            plan_reminder_done = true;
            convo.push(ChatMessage::new(
                "user",
                "【系统提示】本任务已执行多步仍未建立计划。建议先用 plan 工具创建任务计划                 （把目标拆解为可检查的步骤），每步完成即更新状态；简单任务可忽略此提醒。",
            ));
        }

        // ask_user 本地拦截（与 plan 同一位置/风格）：把结构化交互推给前端
        // 卡片，然后本轮立即结束等待用户回答 —— 不执行同轮其它工具，也不再
        // 调用 LLM。无交互通道（子代理/后台任务）时不做拦截，交回运行时兜底。
        if cb.on_interact.is_some() {
            if let Some(call) = turn.tool_calls.iter().find(|call| call.name == "ask_user") {
                let view = parse_interaction(&call.arguments);
                let query = primary_query(&call.arguments);
                if let Some(on_interact) = cb.on_interact {
                    on_interact(&view);
                }
                (cb.on_step)(step_no as u32, "ask_user", &query);
                // 记账（events.jsonl，best-effort）：与普通工具调用一致留痕。
                if let Ok(dir) = ctx.db.data_dir.lock() {
                    let root = dir.join("conversations").join(&ctx.session_id);
                    let _ = crate::infra::store::append_event(
                        &root,
                        serde_json::json!({
                            "ev": "step",
                            "agent": kind.name(),
                            "step": step_no,
                            "tool": call.name,
                            "args_preview": query,
                            "ok": true,
                        }),
                    );
                }
                // 模型可见结果（本轮不会再发 LLM 请求，仅作调用记录）。
                let _pending = ToolOutput::text("已向用户展示交互卡片，本轮结束等待回答");
                return Ok(ReactOutcome {
                    answer: String::new(),
                    hits: all_hits,
                    sub_steps: all_sub_steps,
                    interrupted: false,
                    awaiting_user: true,
                    usage: total_usage,
                });
            }
        }

        // plan 工具本地拦截：计划是 react_loop 的运行时状态机，不经 registry
        // 并发执行；其余工具照常批量执行。
        let mut plan_results: Vec<(ToolCallReq, ToolOutput)> = Vec::new();
        let mut exec_calls: Vec<ToolCallReq> = Vec::new();
        for call in &turn.tool_calls {
            if call.name == "plan" {
                let output = apply_plan(&mut plan, &call.arguments, ctx, kind, step_no as u32);
                if let Some(snapshot) = plan.as_ref().map(PlanState::snapshot) {
                    if let Some(on_plan) = cb.on_plan {
                        on_plan(&snapshot);
                    }
                }
                let query = primary_query(&call.arguments);
                (cb.on_step)(step_no as u32, "plan", &query);
                plan_results.push((call.clone(), output));
            } else {
                exec_calls.push(call.clone());
            }
        }
        for executed in harness().runtime.execute(ctx, &exec_calls) {
            let call = &executed.call;
            let mut outcome = match executed.outcome {
                Ok(outcome) => outcome,
                // Runtime already isolates errors; this arm exists for
                // future non-isolated failures.
                Err(error) => registry::ToolOutput::text(format!("工具执行失败: {error}")),
            };

            let query = primary_query(&call.arguments);
            (cb.on_step)(step_no as u32, call.name.as_str(), &query);

            // Traceability streams (plan/1.0.10-AgentMemory §4): every tool
            // call lands in events.jsonl; failures additionally into
            // errors.jsonl with a resolvable detail span. Best-effort —
            // store failures never fail the turn.
            let tool_failed = outcome.content.starts_with("工具执行失败");
            if let Ok(dir) = ctx.db.data_dir.lock() {
                let root = dir.join("conversations").join(&ctx.session_id);
                let _ = crate::infra::store::append_event(
                    &root,
                    serde_json::json!({
                        "ev": "step",
                        "agent": kind.name(),
                        "step": step_no,
                        "tool": call.name,
                        "args_preview": query,
                        "ok": !tool_failed,
                    }),
                );
                if tool_failed {
                    let _ = crate::infra::store::append_error(
                        &root,
                        &ctx.session_id,
                        step_no as u32,
                        kind.name(),
                        "tool",
                        &outcome.content,
                        &outcome.content,
                    );
                }
            }

            // Memory keeps a rolling retrieval window of its own searches —
            // persisted per session (survives restarts). Best-effort.
            if kind == AgentKind::Memory {
                let entry =
                    agents::make_window_entry(&query, &outcome.content, vec![call.name.clone()]);
                let conn = ctx
                    .db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                if let Err(err) = crate::infra::db::append_memory_window(&conn, &ctx.session_id, entry) {
                    eprintln!("[MEMORY-WINDOW] append failed: {err}");
                }
            }

            // Repetition gate: the identical tool with byte-identical
            // arguments three times in one run triggers a steering nudge
            // instead of burning the remaining budget.
            let key = (call.name.clone(), call.arguments.clone());
            let count = tool_call_counts
                .entry(key)
                .and_modify(|count| *count += 1)
                .or_insert(1);
            if *count == REPEAT_LIMIT {
                convo.push(ChatMessage::new(
                    "user",
                    "【系统提示】检测到同一工具与相同参数被重复调用多次。请停止重复：更换检索角度、改用其他工具，或直接基于已有信息总结回答。",
                ));
            }

            // 视觉附件：工具命中图片文档时带原图（数据 URL），随工具结果
            // 进入多模态消息（仅视觉模型 + 开关开启时非空）。
            let tool_images = std::mem::take(&mut outcome.images);
            all_hits.extend(outcome.hits.iter().cloned());
            all_sub_steps.extend(outcome.sub_steps.iter().cloned());
            convo.push(ChatMessage::tool_result_with_images(
                call.id.clone(),
                outcome.content,
                tool_images,
            ));

            // Nested-agent steps surface as their own step frames so the UI
            // shows them under the same generating bubble.
            for sub in &outcome.sub_steps {
                let detail = if sub.preview.is_empty() {
                    sub.query.clone()
                } else {
                    format!("{} — {}", sub.query, sub.preview)
                };
                (cb.on_step)(
                    step_no as u32,
                    &format!("{}·{}", call.name, sub.action),
                    &detail,
                );
            }
        }

        // plan 工具结果以 tool 消息入列（渲染文本 = 当前计划清单）。
        for (call, output) in plan_results {
            convo.push(ChatMessage::tool_result(call.id.clone(), output.content));
        }
    }

    // Budget exhausted: force a tool-free closing answer.
    if cb.stopped() {
        return Ok(ReactOutcome {
            answer: String::new(),
            hits: all_hits,
            sub_steps: all_sub_steps,
            interrupted: true,
            awaiting_user: false,
            usage: total_usage,
        });
    }
    // 预算用尽：强制总结轮 + 泄漏检测 + 确定性兜底（泄漏内容绝不返回）。
    let summary = stream_forced_summary(client, &mut convo, cb, &mut total_usage)?;
    let answer = if !summary.trim().is_empty() && !looks_like_tool_echo(&summary, &last_tool_args) {
        summary
    } else {
        let fallback = fallback_summary(&tool_names, max_steps);
        (cb.on_delta)(&fallback);
        fallback
    };
    Ok(ReactOutcome {
        answer,
        hits: all_hits,
        sub_steps: all_sub_steps,
        interrupted: false,
        awaiting_user: false,
        usage: total_usage,
    })
}

/// Build the assistant request-shape tool_calls array for the conversation.
fn assistant_tool_calls_payload(turn_tool_calls: &[ToolCallReq]) -> serde_json::Value {
    serde_json::Value::Array(
        turn_tool_calls
            .iter()
            .map(|call| {
                serde_json::json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments }
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_payload_matches_request_shape() {
        let payload = assistant_tool_calls_payload(&[ToolCallReq {
            id: "i".into(),
            name: "vector_search".into(),
            arguments: "{}".into(),
        }]);
        assert_eq!(payload[0]["type"], "function");
        assert_eq!(payload[0]["function"]["name"], "vector_search");
    }

    #[test]
    fn tool_echo_detection_flags_special_markers_and_protocol() {
        assert!(looks_like_tool_echo("正文<|tool▁calls|>", &[]));
        assert!(looks_like_tool_echo("<|end▁of▁sentence|>", &[]));
        assert!(looks_like_tool_echo("前言 <｜begin▁of▁sentence｜>", &[]));
        assert!(looks_like_tool_echo(
            r#"{"tool_calls":[{"id":"a","type":"function","function":{"name":"x","arguments":"{}"}}]}"#,
            &[]
        ));
    }

    #[test]
    fn tool_echo_detection_flags_raw_args_and_parsed_long_values() {
        let long_body = "## 8.1 研究计划\n".repeat(12);
        let raw_args = serde_json::json!({
            "action": "write",
            "section": "8 预期成果",
            "content": long_body,
        })
        .to_string();
        assert!(looks_like_tool_echo(&raw_args, &[raw_args.clone()]));
        // 参数里解析出的长字符串值被当成正文（真实线上案例形态）。
        let echoed = format!("write\n## 8.1 研究计划\n{long_body}");
        assert!(looks_like_tool_echo(&echoed, &[raw_args.clone()]));
        // 与上一轮参数无关的长文本不算泄漏。
        assert!(!looks_like_tool_echo(
            &"这是正常的总结文本，说明已写入第 8 节与参考文献。".repeat(4),
            &[raw_args]
        ));
    }

    #[test]
    fn tool_echo_detection_keeps_normal_and_empty_text() {
        assert!(!looks_like_tool_echo("", &[]));
        assert!(!looks_like_tool_echo("   ", &[]));
        assert!(!looks_like_tool_echo(
            "已完成开题报告第 8 节与参考文献的写入，产物位于写作页的初稿文档，下一步请审阅。",
            &[]
        ));
        // 正常讨论里出现 tool_calls 字眼但句子是自然语言 → 不误判。
        assert!(!looks_like_tool_echo(
            "tool_calls 是模型调用工具时的协议字段，这里只是解释它的含义。",
            &[]
        ));
    }

    #[test]
    fn fallback_summary_mentions_tools_and_steps() {
        let text = fallback_summary(
            &["academic_manuscript".to_string(), "academic_manuscript".to_string()],
            3,
        );
        assert!(text.contains("共 3 步"), "{text}");
        assert!(text.contains("academic_manuscript"), "{text}");
        assert!(text.contains("写作"), "{text}");
        assert!(text.contains("重新生成"), "{text}");
    }
}
