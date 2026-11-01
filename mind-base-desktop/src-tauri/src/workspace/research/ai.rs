//! 科研域 AI：目标期刊推荐与研究计划生成（LLM 调用 + 容错 JSON 解析 + 编排）。
//!
//! 编排函数调用 LLM 时不持有 DB 锁：先短锁读取上下文/构造 prompt，释放锁后
//! 阻塞调用模型，再短锁持久化并写事件。命令层与 agent 工具共用这些函数。

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::llm::client::{chat_client_from_conn, ChatClient, ChatMessage};
use crate::repositories::research::events;

use super::service;
use super::{PlanTask, ResearchPlan, VenueSuggestion, STAGES, STAGE_LABELS};

// 期刊推荐命令由 Lead 在 app/commands.rs 注册；注册前 crate 内暂无调用方。
#[allow(dead_code)]
const MAX_VENUE_SUGGESTIONS: usize = 5;

fn lock_conn(conn: &Arc<Mutex<Connection>>) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    conn.lock().map_err(|_| "数据库锁失败".to_string())
}

fn no_model_error() -> String {
    "未配置对话模型，请先在「API 设置」中填写提供方密钥".to_string()
}

/// 从模型回复里提取 JSON 块：容忍 Markdown 代码围栏与前后说明文字。
pub(crate) fn extract_json_block(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after
            .strip_prefix("json")
            .or_else(|| after.strip_prefix("JSON"))
            .unwrap_or(after);
        let after = after.trim_start_matches(['\r', '\n', ' ']);
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }
    let first = trimmed
        .char_indices()
        .find(|(_, ch)| *ch == '{' || *ch == '[')
        .map(|(index, _)| index);
    if let Some(start) = first {
        let closing = if trimmed.as_bytes()[start] == b'{' {
            '}'
        } else {
            ']'
        };
        if let Some(end) = trimmed.rfind(closing) {
            if end > start {
                return trimmed[start..=end].trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn text_list(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Vec<String> {
    object
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(text) => {
                        let text = text.trim();
                        if text.is_empty() {
                            None
                        } else {
                            Some(text.to_string())
                        }
                    }
                    serde_json::Value::Object(map) => map
                        .get("label")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 解析期刊推荐输出（JSON 数组；容忍围栏与纯字符串数组）。
#[allow(dead_code)]
pub(crate) fn parse_venue_response(raw: &str) -> Result<Vec<VenueSuggestion>, String> {
    let block = extract_json_block(raw);
    let value: serde_json::Value = serde_json::from_str(&block)
        .map_err(|err| format!("期刊推荐 JSON 解析失败：{err}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "期刊推荐输出必须是 JSON 数组".to_string())?;
    let mut suggestions: Vec<VenueSuggestion> = Vec::new();
    for item in items {
        let (venue, reason, score) = match item {
            serde_json::Value::String(name) => (name.trim().to_string(), String::new(), 60_i64),
            serde_json::Value::Object(map) => {
                let venue = map
                    .get("venue")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let reason = map
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let score = map
                    .get("matchScore")
                    .and_then(|value| value.as_i64())
                    .or_else(|| {
                        map.get("matchScore")
                            .and_then(|value| value.as_f64())
                            .map(|value| value.round() as i64)
                    })
                    .unwrap_or(60)
                    .clamp(0, 100);
                (venue, reason, score)
            }
            _ => continue,
        };
        if venue.is_empty()
            || suggestions
                .iter()
                .any(|existing| existing.venue.eq_ignore_ascii_case(&venue))
        {
            continue;
        }
        suggestions.push(VenueSuggestion {
            venue,
            reason,
            match_score: score,
        });
        if suggestions.len() >= MAX_VENUE_SUGGESTIONS {
            break;
        }
    }
    if suggestions.is_empty() {
        return Err("模型没有返回可用的期刊推荐（JSON 数组为空或缺少 venue）".to_string());
    }
    Ok(suggestions)
}

/// 解析研究计划输出（JSON 对象；tasks 的 id 由后端重排为 t1..tN，保证稳定）。
pub(crate) fn parse_plan_response(
    raw: &str,
    stage: &str,
    generated_at: i64,
) -> Result<ResearchPlan, String> {
    let block = extract_json_block(raw);
    let value: serde_json::Value = serde_json::from_str(&block)
        .map_err(|err| format!("研究计划 JSON 解析失败：{err}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "研究计划输出必须是 JSON 对象".to_string())?;

    let mut tasks: Vec<PlanTask> = Vec::new();
    if let Some(items) = object.get("tasks").and_then(|value| value.as_array()) {
        for item in items {
            let label = match item {
                serde_json::Value::String(text) => text.trim().to_string(),
                serde_json::Value::Object(map) => map
                    .get("label")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                _ => String::new(),
            };
            if label.is_empty() {
                continue;
            }
            tasks.push(PlanTask {
                id: format!("t{}", tasks.len() + 1),
                label,
            });
        }
    }
    if tasks.is_empty() {
        return Err("研究计划 JSON 缺少 tasks（至少 1 项）".to_string());
    }

    let stage_label = STAGES
        .iter()
        .position(|candidate| candidate == &stage)
        .map(|index| STAGE_LABELS[index])
        .unwrap_or(stage);
    let goal = object
        .get("goal")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let goal = if goal.is_empty() {
        format!("完成「{stage_label}」阶段目标")
    } else {
        goal
    };

    Ok(ResearchPlan {
        stage: stage.to_string(),
        goal,
        tasks,
        deliverables: text_list(object, "deliverables"),
        acceptance: text_list(object, "acceptance"),
        risks: text_list(object, "risks"),
        prompts: text_list(object, "prompts"),
        generated_at,
        source: "ai".to_string(),
    })
}

#[allow(dead_code)]
fn venue_system_prompt() -> &'static str {
    "你是资深学术编辑，熟悉各学科期刊/会议的方向与投稿要求。     请结合研究项目信息与近期文献的发表渠道，推荐最匹配的投稿目标。     只输出 JSON 数组，不要 Markdown 围栏、不要解释文字。     数组元素格式：{\"venue\":\"期刊或会议全名\",\"reason\":\"推荐理由（中文，一句话）\",\"matchScore\":0-100 的整数}。     给出 3-5 个候选，按匹配度从高到低排序；不要编造不存在的期刊。"
}

fn plan_system_prompt() -> &'static str {
    "你是科研项目管理助手，负责把一个科研阶段拆成可执行、可验收的任务清单。     只输出 JSON 对象，不要 Markdown 围栏、不要解释文字。     格式：{\"goal\":\"本阶段目标（中文一句话）\",\"tasks\":[{\"label\":\"具体任务\"}],     \"deliverables\":[\"交付物\"],\"acceptance\":[\"验收标准\"],\"risks\":[\"风险\"],\"prompts\":[\"给用户的自检提示\"]}。     tasks 3-6 条，动词开头、单条可完成；不要编造实验数据或文献。"
}

fn project_context(
    conn: &Connection,
    project_id: &str,
    stage: Option<&str>,
) -> Result<String, String> {
    let detail = service::detail(conn, project_id)?;
    let project = detail.project;
    let mut out = String::new();
    out.push_str(&format!("项目标题：{}\n", project.title));
    out.push_str(&format!("论文类型：{}\n", project.paper_kind));
    if !project.field.trim().is_empty() {
        out.push_str(&format!("研究方向：{}\n", project.field));
    }
    out.push_str(&format!("写作语言：{}\n", project.language));
    out.push_str(&format!(
        "当前目标期刊：{}\n",
        if project.target_venue.trim().is_empty() {
            "未填写"
        } else {
            project.target_venue.as_str()
        }
    ));
    if !project.deadline.trim().is_empty() {
        out.push_str(&format!("截止时间：{}\n", project.deadline));
    }
    if let Some(stage) = stage {
        let stage_label = STAGES
            .iter()
            .position(|candidate| candidate == &stage)
            .map(|index| STAGE_LABELS[index])
            .unwrap_or(stage);
        out.push_str(&format!("目标阶段：{stage}（{stage_label}）\n"));
    }
    let venues = service::literature_venues(conn, project_id, 8)?;
    if !venues.is_empty() {
        out.push_str(&format!("近期文献发表渠道：{}\n", venues.join("；")));
    }
    Ok(out)
}

fn run_llm(client: &ChatClient, messages: &[ChatMessage]) -> Result<String, String> {
    let mut answer = String::new();
    client
        .stream_turn(messages, None, &mut |delta| answer.push_str(delta), None)
        .map_err(|err| format!("对话模型调用失败：{err}"))?;
    if answer.trim().is_empty() {
        return Err("对话模型返回空内容，请重试".to_string());
    }
    Ok(answer)
}

/// 生成 3-5 个目标期刊/会议候选，并记 venue.recommended 事件。
#[allow(dead_code)]
pub(crate) fn recommend_venues(
    conn: &Arc<Mutex<Connection>>,
    project_id: &str,
    now: i64,
) -> Result<Vec<VenueSuggestion>, String> {
    let (client, messages) = {
        let guard = lock_conn(conn)?;
        let client = chat_client_from_conn(&guard)?.ok_or_else(no_model_error)?;
        let context = project_context(&guard, project_id, None)?;
        let messages = vec![
            ChatMessage::new("system", venue_system_prompt()),
            ChatMessage::new(
                "user",
                format!("{context}\n请推荐 3-5 个最合适的投稿目标（期刊或会议）。"),
            ),
        ];
        (client, messages)
    };
    let raw = run_llm(&client, &messages)?;
    let suggestions = parse_venue_response(&raw)?;
    {
        let guard = lock_conn(conn)?;
        let _ = events::append(
            &guard,
            project_id,
            "agent",
            "venue.recommended",
            &serde_json::json!({"count": suggestions.len()}).to_string(),
            now,
        );
    }
    Ok(suggestions)
}

/// 生成并持久化某阶段的研究计划（plan.generated 事件由 service::save_plan 写）。
pub(crate) fn generate_plan(
    conn: &Arc<Mutex<Connection>>,
    project_id: &str,
    stage: &str,
    now: i64,
) -> Result<ResearchPlan, String> {
    if !STAGES.contains(&stage) {
        return Err(format!("未知阶段：{stage}"));
    }
    let (client, messages) = {
        let guard = lock_conn(conn)?;
        let client = chat_client_from_conn(&guard)?.ok_or_else(no_model_error)?;
        let context = project_context(&guard, project_id, Some(stage))?;
        let messages = vec![
            ChatMessage::new("system", plan_system_prompt()),
            ChatMessage::new(
                "user",
                format!("{context}\n请为「{stage}」阶段生成研究计划。"),
            ),
        ];
        (client, messages)
    };
    let raw = run_llm(&client, &messages)?;
    let plan = parse_plan_response(&raw, stage, now)?;
    {
        let guard = lock_conn(conn)?;
        service::save_plan(&guard, project_id, &plan, now)?;
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venue_json_parsing_tolerates_fences_and_clamps_scores() {
        let raw = "以下是推荐：\n```json\n[{\"venue\":\"Nature\",\"reason\":\"综合顶刊\",\"matchScore\":120},\
                   {\"venue\":\"某会议\",\"reason\":\"方向相关\",\"matchScore\":-5},\
                   {\"venue\":\"Nature\",\"reason\":\"重复\",\"matchScore\":90}]\n```";
        let suggestions = parse_venue_response(raw).expect("parse venues");
        assert_eq!(suggestions.len(), 2, "{suggestions:?}");
        assert_eq!(suggestions[0].venue, "Nature");
        assert_eq!(suggestions[0].match_score, 100);
        assert_eq!(suggestions[1].match_score, 0);
        assert!(suggestions.iter().all(|item| !item.reason.is_empty()));
    }

    #[test]
    fn venue_json_without_array_or_venue_is_rejected() {
        assert!(parse_venue_response("{\"venue\":\"x\"}").is_err());
        assert!(parse_venue_response("[]").is_err());
        assert!(parse_venue_response("not json").is_err());
    }

    #[test]
    fn plan_json_parsing_normalizes_task_ids_and_lists() {
        let raw = "```json\n{\"goal\":\"完成实验设计\",\"tasks\":[\"写方法\",{\"label\":\"准备数据\"}],                   \"deliverables\":[\"方法章节\"],\"acceptance\":[\"评审通过\"],\"risks\":[\"数据不足\"],\"prompts\":[\"检查伦理\"]}\n```";
        let plan = parse_plan_response(raw, "design", 1_700_000_000).expect("parse plan");
        assert_eq!(plan.stage, "design");
        assert_eq!(plan.goal, "完成实验设计");
        assert_eq!(
            plan.tasks
                .iter()
                .map(|task| (task.id.as_str(), task.label.as_str()))
                .collect::<Vec<_>>(),
            vec![("t1", "写方法"), ("t2", "准备数据")]
        );
        assert_eq!(plan.deliverables, vec!["方法章节".to_string()]);
        assert_eq!(plan.acceptance, vec!["评审通过".to_string()]);
        assert_eq!(plan.risks, vec!["数据不足".to_string()]);
        assert_eq!(plan.prompts, vec!["检查伦理".to_string()]);
        assert_eq!(plan.source, "ai");
        assert_eq!(plan.generated_at, 1_700_000_000);
    }

    #[test]
    fn plan_json_requires_tasks() {
        let raw = "{\"goal\":\"x\",\"tasks\":[]}";
        let err = parse_plan_response(raw, "design", 0).expect_err("empty tasks rejected");
        assert!(err.contains("tasks"), "{err}");
    }

    #[test]
    fn json_block_extraction_handles_prose_and_plain_objects() {
        assert_eq!(
            extract_json_block("说明文字 {\"a\":1} 结尾"),
            "{\"a\":1}"
        );
        assert_eq!(extract_json_block("[1,2]"), "[1,2]");
    }
}
