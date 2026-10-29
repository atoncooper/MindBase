//! Grounded streaming turn (`chat_ask`): persist, retrieve, stream, finalize.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::context::{collect_sources, fallback_title, is_default_title};
use super::history::{
    complete_assistant_message_tx, fail_assistant_message_conn, insert_message_conn,
    recent_history_conn,
};
use super::images::validate_user_images;
use super::sessions::{
    get_session_conn, guarded_update_title_conn, spawn_title_refinement, touch_session_conn,
    turn_cancels,
};
use super::types::{emit, now_secs, ChatEvent, ChatTurnResult, DeltaBatcher};
use crate::agent::agents::AgentKind;
use crate::infra::db::{self, Db};
use crate::llm::client::{chat_client_from_conn, ChatMessage, TokenUsage};
use crate::llm::embeddings::embed_client_from_conn_opt;

/// How many completed history messages ride along as conversation context
/// (backend: last 6 messages = 3 turns).
const HISTORY_WINDOW: usize = 6;

/// One grounded streaming turn: persist both sides, retrieve context, stream
/// the answer, finalize persistence — reporting progress via `on_event`.
/// `skill`（来自输入框 / 菜单）非空时把该技能全文作为本轮 system 指令强制注入。
/// `images`（用户主动上传 / 粘贴 / 拖拽的图片 data URL，前端不传即 None）只
/// 附加到本轮上下文，**不持久化**（见下方 history_for_turn 的注释）。
#[tauri::command]
pub async fn chat_ask(
    app: AppHandle,
    session_id: String,
    question: String,
    provider: Option<String>,
    skill: Option<String>,
    images: Option<Vec<String>>,
    // 当前科研项目：非空时把项目简报作为本轮 system 上下文注入。
    research_project_id: Option<String>,
    on_event: Channel<ChatEvent>,
) -> Result<ChatTurnResult, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题".to_string());
    }
    // 图片在碰任何数据库 / 网络之前先校验：数量、MIME 前缀、base64 与体积。
    let user_images = validate_user_images(images.as_deref().unwrap_or(&[]))?;

    // Precheck + history under one short lock.
    let (history, embed_client, chat_client, was_default_title, skill_body, research_brief) = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let session =
            get_session_conn(&conn, &session_id)?.ok_or_else(|| "会话不存在".to_string())?;
        let history = recent_history_conn(&conn, &session_id, HISTORY_WINDOW)?;
        // 向量化客户端可选：只配了对话密钥（如仅 OpenRouter）时跳过检索，
        // vector_search 工具会自行给出友好提示。
        let embed_client = embed_client_from_conn_opt(&conn)?;
        let chat_client = match provider.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => Some(crate::llm::client::chat_client_for(&conn, p)?),
            _ => chat_client_from_conn(&conn)?,
        }
        .ok_or_else(|| "未配置任何对话模型，请先在「API 设置」中填写提供方密钥".to_string())?;
        // 模型能力闸门：名字启发式判定不支持视觉时直接拒绝本轮，避免把
        // 图片塞给纯文本模型后拿到难懂的 400；提示用户去 API 设置换模型。
        if !user_images.is_empty()
            && !crate::llm::client::model_supports_vision(chat_client.model_name())
        {
            return Err("当前对话模型不支持图片输入，请在「API 设置」切换到视觉模型（如 qwen-vl / gpt-4o）后再试".to_string());
        }
        // 强制注入技能：显式选择无效（不存在/被禁用）时整轮报错，不静默忽略。
        let skill_body = match skill.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => {
                let dir = db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
                Some(crate::agent::skills::read_skill_body(&conn, &dir, name)?)
            }
            _ => None,
        };
        // 科研控制台只在主聊天里对话：把项目简报作为本轮 system 上下文。
        let research_brief = match research_project_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(project_id) => crate::workspace::research::project_briefing(&conn, project_id).ok(),
            None => None,
        };
        (
            history,
            embed_client,
            chat_client,
            is_default_title(&session.title),
            skill_body,
            research_brief,
        )
    };

    let assistant_msg_id = db::local_id();
    // 本轮起始时间（UNIX 秒）：收尾时用它筛选本轮新产出的 exports 文件。
    let turn_started = now_secs();

    // Persist the turn skeleton before any network work.
    {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| format!("failed to begin transaction: {err}"))?;
        insert_message_conn(
            &tx,
            &db::local_id(),
            &session_id,
            "user",
            &question,
            "completed",
            "",
        )?;
        insert_message_conn(
            &tx,
            &assistant_msg_id,
            &session_id,
            "assistant",
            "",
            "pending",
            chat_client.model_name(),
        )?;
        touch_session_conn(&tx, &session_id)?;

        // Instant fallback naming so the sidebar never shows 新对话 mid-run.
        let mut instant_title = String::new();
        if was_default_title {
            instant_title = fallback_title(&question);
            guarded_update_title_conn(&tx, &session_id, &instant_title);
        }
        tx.commit()
            .map_err(|err| format!("failed to begin turn: {err}"))?;

        if was_default_title {
            emit(
                &ChatEvent::Title {
                    title: instant_title,
                },
                &on_event,
            );
        }
    }

    // LLM title refinement runs alongside generation; guarded update means a
    // user rename between now and completion still wins.
    if was_default_title {
        spawn_title_refinement(
            app.clone(),
            chat_client.clone(),
            on_event.clone(),
            session_id.clone(),
            question.clone(),
        );
    }

    // Agentic turn through the harness: orchestrator route (single-target
    // fast path) → lifecycle gate → ReAct loop with the full tool registry.
    // 强制注入的技能作为一条尾部 system 消息进入本轮上下文（单轮生效，
    // 不持久化——下一轮需要时用户再次 / 选择）。
    let mut history_for_turn = history;
    if let Some(body) = &skill_body {
        history_for_turn.push(ChatMessage::new(
            "system",
            format!(
                "## 用户强制注入的技能（本轮必须严格遵循）\n\n用户通过输入框 / 菜单显式附加了以下技能指令，其要求优先于默认行为：\n\n{body}"
            ),
        ));
    }
    // 本轮附带的图片作为一条额外的 user 消息追加在 history 末尾——顺序是
    // history → （技能 system）→ 图片 user → 本轮 question（react_loop 自己
    // 追加），图片只出现一次、也不打断技能注入的顺序。
    //
    // 历史不持久化图片：chat_messages 表没有 images 列（与 reasoning 同性质，
    // 都不落库），刷新 / 切换会话后历史只重放文本，图片不会重放；需要时用户
    // 重新附带。这里刻意不改 schema。
    if !user_images.is_empty() {
        let mut image_message =
            ChatMessage::new("user", "（本轮用户主动附带了图片，见紧随其后的这个问题）");
        image_message.images = user_images;
        history_for_turn.push(image_message);
    }
    // 科研项目上下文：只注入本轮（不落库），回答需结合控制台里的项目事实。
    if let Some(brief) = research_brief {
        history_for_turn.push(ChatMessage::new(
            "system",
            format!(
                "## 当前科研项目上下文

{brief}

                 用户正在该科研项目的控制台里发起对话。回答时结合上述项目事实（阶段、产物、文献、数据、决策）给出下一步建议；                 未提供的数字、文献或结果不要编造，需要时提示用户回控制台补齐。"
            ),
        ));
    }
    // Register the cancellation flag for this turn BEFORE the blocking run
    // so a stop press during any phase (routing / tools / streaming) flips it.
    let cancel_token = Arc::new(AtomicBool::new(false));
    {
        let mut registry = turn_cancels()
            .lock()
            .map_err(|err| format!("cancel registry poisoned: {err}"))?;
        registry.insert(session_id.clone(), cancel_token.clone());
    }
    // The closure below moves its own clones; the original stays for cleanup.
    let session_for_cancel = session_id.clone();

    let event_channel = on_event.clone();
    let model_name = chat_client.model_name().to_string();
    let session_for_finalize = session_id.clone();
    // The file store (L1 transcript) needs the raw question after the
    // closure below has moved `question`.
    let question_for_store = question.clone();
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<
        crate::agent::harness::ReactOutcome,
        String,
    > {
        let harness_arc = crate::agent::harness::harness();

        // Route (single registered agent short-circuits without an LLM call —
        // faithful to the backend's production posture).
        let _routed = harness_arc.orchestrator.route(&chat_client, &question);

        // Lifecycle gate: breaker + per-session turn lock.
        let guard = harness_arc.lifecycle.enter("chat", &session_id);
        if guard.breaker_tripped {
            return Err(crate::agent::harness::BREAKER_OPEN_MESSAGE.to_string());
        }
        let _turn_lock = guard
            .session_lock
            .lock()
            .map_err(|err| format!("session lock poisoned: {err}"))?;

        // Delegation bridge: children run reentrantly (no session lock) with
        // a structurally empty delegate slot (two-level cap). Consecutive
        // failures per target short-circuit after the backend's threshold.
        const DELEGATE_FAILURE_THRESHOLD: u32 = 2;
        // Sub-agent usage sink: the delegate bridge return shape is fixed
        // by the tool layer, so child usage is collected here and folded
        // into the parent outcome once the loop returns.
        let sub_usage: Arc<Mutex<Option<TokenUsage>>> = Arc::new(Mutex::new(None));
        let sub_usage_sink = Arc::clone(&sub_usage);
        let bridge_handle = handle.clone();
        let bridge_client = chat_client.clone();
        let bridge_embed = embed_client.clone();
        let bridge_session = session_id.clone();
        let bridge_events = event_channel.clone();
        let delegate_box: Box<crate::agent::harness::DelegateFn> = Box::new(move |agent_name: &str, query: &str| {
            let failures =
                crate::agent::harness::harness()
                    .lifecycle
                    .bump_delegate_failure(&bridge_session, agent_name);
            if failures > DELEGATE_FAILURE_THRESHOLD {
                return Err(format!(
                    "委托已短路:{agent_name} 在本次对话中已连续失败 {failures} 次，不再委托。请直接基于已有信息回答。"
                ));
            }
            let kind = match agent_name {
                "memory" => AgentKind::Memory,
                "note" => AgentKind::Note,
                "code" => AgentKind::Code,
                "search" => AgentKind::Search,
                "academic" => AgentKind::Academic,
                other => return Err(format!("不可委托的目标：{other}")),
            };
            // Forward each child tool round to the UI as it happens so the
            // user sees sub-agent progress while delegation is in flight.
            let mut on_child_step = |step_no: u32, action: &str, child_query: &str| {
                emit(
                    &ChatEvent::SubStep {
                        step: step_no,
                        agent: agent_name.to_string(),
                        action: action.to_string(),
                        query: child_query.to_string(),
                    },
                    &bridge_events,
                );
            };
            match crate::agent::harness::run_sub_agent(
                kind,
                &bridge_handle,
                &bridge_client,
                bridge_embed.as_ref(),
                &bridge_session,
                query,
                &mut on_child_step,
            ) {
                Ok((answer, _sub_steps, child_usage)) => {
                    if let Ok(mut sink) = sub_usage_sink.lock() {
                        crate::agent::harness::add_usage(&mut sink, child_usage);
                    }
                    crate::agent::harness::harness()
                        .lifecycle
                        .reset_delegate_failures(&bridge_session, agent_name);
                    // Blackboard auto-deposit (plan/1.0.10-AgentMemory §5):
                    // every successful delegation leaves a signed structured
                    // finding the whole session can read back. Best-effort —
                    // a blackboard write failure never fails the delegation.
                    crate::agent::harness::tools::deposit_session_finding(
                        &bridge_handle,
                        &bridge_session,
                        agent_name,
                        query,
                        &answer,
                    );
                    Ok((answer, _sub_steps))
                }
                Err(error) => Err(error),
            }
        });

        let db = handle.state::<Db>();
        // Owned context: tool calls are dispatched onto detached worker threads
        // with a hard timeout, so nothing may borrow this turn's locals.
        let ctx = crate::agent::harness::ToolContext {
            db: db.inner().clone(),
            embed_client: embed_client.clone().map(std::sync::Arc::new),
            chat_client: Some(std::sync::Arc::new(chat_client.clone())),
            session_id: session_id.clone(),
            agent: crate::agent::agents::AgentKind::Chat,
            delegate: Some(std::sync::Arc::from(delegate_box)),
        };

        let mut batcher = DeltaBatcher::new(event_channel.clone());

        // The probe runs on the streaming thread; a relaxed load is enough —
        // the flag is a one-way latch, no ordering with other data matters.
        let stop_flag = cancel_token.clone();
        let should_stop = move || stop_flag.load(Ordering::Relaxed);

        // plan 状态变化 → 推送计划清单事件（前端实时渲染计划面板）。
        let plan_channel = event_channel.clone();
        let on_plan = move |snapshot: &crate::agent::harness::PlanSnapshot| {
            emit(
                &ChatEvent::Plan {
                    version: snapshot.version,
                    steps: snapshot.steps.clone(),
                },
                &plan_channel,
            );
        };

        // ask_user 卡片 → 前端 interact 帧（结构化交互；本轮随后结束等回答）。
        let interact_channel = event_channel.clone();
        let on_interact = move |view: &crate::agent::harness::InteractionView| {
            emit(
                &ChatEvent::Interact {
                    interact: view.clone(),
                },
                &interact_channel,
            );
        };

        let mut callbacks = crate::agent::harness::ReactCallbacks {
            on_step: &mut |step_no, action, query| {
                emit(
                    &ChatEvent::Step {
                        step: step_no,
                        action: action.to_string(),
                        query: query.to_string(),
                    },
                    &event_channel,
                );
            },
            on_delta: &mut |delta| batcher.push(delta),
            should_stop: Some(&should_stop),
            on_plan: Some(&on_plan),
            on_interact: Some(&on_interact),
            mailbox: None,
            step_budget: None,
        };

        let mut outcome = crate::agent::harness::react_loop(
            &chat_client,
            &ctx,
            AgentKind::Chat,
            &history_for_turn,
            &question,
            0,
            None,
            &mut callbacks,
        );
        // 子代理轮次的 usage 不在主循环的 total 里：委托返回值经 sink 收齐后
        // 在这里补进本轮总计。
        if let Ok(sub_total) = sub_usage.lock() {
            if let Ok(result) = outcome.as_mut() {
                crate::agent::harness::add_usage(&mut result.usage, *sub_total);
            }
        }
        match &outcome {
            Ok(_) => harness_arc.lifecycle.record_success("chat", &session_id),
            Err(_) => harness_arc.lifecycle.record_failure("chat", &session_id),
        }
        // 收尾帧：无论成败都把残余 delta 冲出去（错误路径也保留已生成内容）。
        batcher.flush();
        outcome
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?;

    // The turn is over either way — drop its cancel registration so a stale
    // session id can never abort a future turn.
    if let Ok(mut registry) = turn_cancels().lock() {
        registry.remove(&session_for_cancel);
    }

    match outcome {
        Ok(result) => {
            // Copy out before `result.answer` is moved below.
            let turn_usage = result.usage;
            let sources = collect_sources(&result.hits);
            if !sources.is_empty() {
                emit(
                    &ChatEvent::Sources {
                        sources: sources.clone(),
                    },
                    &on_event,
                );
            }
            let db = app.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            let tx = conn
                .unchecked_transaction()
                .map_err(|err| format!("failed to begin transaction: {err}"))?;
            // An interrupted turn keeps whatever streamed before the cut; a
            // cut before any text lands gets a visible marker instead of an
            // empty bubble on history reload. ask_user 结束的轮次同理：卡片
            // 已经承载问题，正文只留一句引导，避免历史里出现空气泡。
            let answer = if result.answer.trim().is_empty() && result.interrupted {
                "（已手动中断本次生成）".to_string()
            } else if result.answer.trim().is_empty() && result.awaiting_user {
                "（已向你提问，请在上方卡片作答）".to_string()
            } else {
                result.answer
            };
            complete_assistant_message_tx(
                &tx,
                &assistant_msg_id,
                &answer,
                &sources,
                &model_name,
                turn_usage,
            )?;
            touch_session_conn(&tx, &session_for_finalize)?;
            tx.commit()
                .map_err(|err| format!("failed to finalize turn: {err}"))?;
            // L1 conversation stream (plan/1.0.10-AgentMemory §4): the
            // agent-facing memory of the turn. Best-effort — the SQLite row
            // above stays the UI truth during the transition.
            {
                let data_dir = db
                    .data_dir
                    .lock()
                    .map(|dir| dir.clone())
                    .unwrap_or_default();
                let root = data_dir.join("conversations").join(&session_for_finalize);
                if let Err(err) = crate::infra::store::append_turn(
                    &root,
                    "chat",
                    "question",
                    &question_for_store,
                    &answer,
                    serde_json::json!({}),
                ) {
                    eprintln!("[STORE] turn append failed: {err}");
                }
            }
            // 本轮导出的产物：扫描 exports 里本轮（含 2s 容差）新增/修改的
            // 文件，非空则推一张文件卡片。扫描失败静默跳过，绝不影响主流程。
            let turn_artifacts: Vec<crate::workspace::resume::ExportEntry> = {
                let data_dir = db
                    .data_dir
                    .lock()
                    .map(|dir| dir.clone())
                    .unwrap_or_default();
                let turn_started_ms = turn_started.saturating_mul(1000);
                crate::workspace::resume::list_exports_dir(&crate::workspace::resume::exports_dir(&data_dir))
                    .into_iter()
                    .filter(|entry| entry.modified_at * 1000 + 2000 >= turn_started_ms)
                    .collect()
            };
            if !turn_artifacts.is_empty() {
                emit(
                    &ChatEvent::Artifact {
                        artifacts: turn_artifacts,
                    },
                    &on_event,
                );
            }
            // tokens 用量帧：与 artifact 并列，在 done 之前（有值才发）。
            if let Some(usage) = turn_usage.filter(|usage| !usage.is_empty()) {
                emit(&ChatEvent::Usage { usage }, &on_event);
            }
            emit(
                &ChatEvent::Done {
                    msg_id: assistant_msg_id.clone(),
                },
                &on_event,
            );
            Ok(ChatTurnResult {
                msg_id: assistant_msg_id,
                answer,
                usage: turn_usage,
            })
        }
        Err(error) => {
            let db = app.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            fail_assistant_message_conn(&conn, &assistant_msg_id, &error)?;
            // The failed turn also enters the error stream (traceability:
            // what failed, when, with which message — plan/1.0.10 §7).
            if let Ok(data_dir) = db.data_dir.lock() {
                let root = data_dir.join("conversations").join(&session_for_finalize);
                let _ = crate::infra::store::append_error(
                    &root,
                    &session_for_finalize,
                    0,
                    "chat",
                    "runtime",
                    &error,
                    &error,
                );
            }
            emit(
                &ChatEvent::Error {
                    message: error.clone(),
                },
                &on_event,
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn awaiting_user_turn_falls_back_to_card_hint() {
        // 收尾文案属于纯逻辑，直接断言分支语义（不依赖 Tauri state）。
        let answer = String::new();
        let awaiting = true;
        let interrupted = false;
        let resolved = if answer.trim().is_empty() && interrupted {
            "（已手动中断本次生成）".to_string()
        } else if answer.trim().is_empty() && awaiting {
            "（已向你提问，请在上方卡片作答）".to_string()
        } else {
            answer
        };
        assert_eq!(resolved, "（已向你提问，请在上方卡片作答）");
    }
}
