//! Chat DTOs, stream frames and the token-usage persistence contract.

use serde::Serialize;
use tauri::ipc::Channel;

use crate::llm::client::TokenUsage;

pub(super) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionRow {
    pub chat_session_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_message_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub msg_id: String,
    pub chat_session_id: String,
    /// user | assistant
    pub role: String,
    pub content: String,
    /// pending | completed | failed
    pub status: String,
    pub sources: serde_json::Value,
    pub model: String,
    pub error: String,
    pub created_at: i64,
    /// Provider-reported token usage of the turn that produced this
    /// message (`None` for user rows / unmetered providers).
    pub usage: Option<TokenUsage>,
}

/// Provenance entry attached to an assistant message (backend source shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSource {
    pub title: String,
    pub page_title: String,
    pub score: f32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub bvid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    pub page_index: i64,
}

/// One progress frame pushed during `chat_ask`.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    /// Harness executed one tool round (`action` = vector_search).
    Step {
        step: u32,
        action: String,
        query: String,
    },
    /// A delegated sub-agent executed one of its internal tool rounds.
    SubStep {
        step: u32,
        agent: String,
        action: String,
        query: String,
    },
    /// 任务计划的创建/更新（plan 工具）：前端渲染实时计划清单。
    Plan {
        version: u32,
        steps: Vec<crate::agent::harness::PlanStepView>,
    },
    /// ask_user 结构化交互：前端渲染澄清选项 / 确认卡 / 表单。
    Interact {
        interact: crate::agent::harness::InteractionView,
    },
    /// 本轮导出的文件（exports 内新增产物）：前端渲染文件卡片。
    Artifact {
        artifacts: Vec<crate::workspace::resume::ExportEntry>,
    },
    Chunk {
        content: String,
    },
    /// 一个子代理运行结束：耗时 / 步数 / 该子代理自己的 token 用量。
    /// 用于前端记录「哪个 agent 跑了多久、花了多少 token、跑了几轮」。
    AgentRun {
        agent: String,
        ok: bool,
        duration_ms: u64,
        steps: u32,
        usage: Option<TokenUsage>,
    },
    /// 本轮 token 用量（含工具轮次与子代理聚合；提供方未上报时不发）。
    Usage {
        usage: TokenUsage,
    },
    Sources {
        sources: Vec<ChatSource>,
    },
    Title {
        title: String,
    },
    Done {
        msg_id: String,
    },
    Error {
        message: String,
    },
}

pub(super) fn emit(event: &ChatEvent, channel: &Channel<ChatEvent>) {
    let _ = channel.send(event.clone());
}

/// 流式 delta 合帧器：SSE 每 token 一次回调，若逐条跨 IPC 会以每秒上百次
/// 的频率轰击 webview（序列化 + 全列表重渲染），表现为卡顿掉帧。这里把
/// delta 缓冲进 50ms 一帧再发送，IPC 次数下降两个数量级，肉眼依旧流畅。
pub(super) struct DeltaBatcher {
    channel: Channel<ChatEvent>,
    buffer: String,
    last_flush: std::time::Instant,
    interval: std::time::Duration,
}

impl DeltaBatcher {
    pub(super) fn new(channel: Channel<ChatEvent>) -> Self {
        Self {
            channel,
            buffer: String::new(),
            last_flush: std::time::Instant::now(),
            interval: std::time::Duration::from_millis(50),
        }
    }

    pub(super) fn push(&mut self, delta: &str) {
        self.buffer.push_str(delta);
        if self.last_flush.elapsed() >= self.interval {
            self.flush();
        }
    }

    /// 帧结束必须调用：把残余缓冲发出去，避免最后一截文字滞留。
    pub(super) fn flush(&mut self) {
        if !self.buffer.is_empty() {
            let content = std::mem::take(&mut self.buffer);
            emit(&ChatEvent::Chunk { content }, &self.channel);
        }
        self.last_flush = std::time::Instant::now();
    }
}

/// Final outcome of one turn (mirrors the persisted assistant message).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnResult {
    pub msg_id: String,
    pub answer: String,
    /// 本轮聚合 token 用量（None = 提供方未上报）。
    pub usage: Option<TokenUsage>,
}

/// Parse the persisted `chat_messages.usage` JSON back into counters.
/// `{}` (schema default / unmetered turn), unreadable payloads and
/// all-zero objects all mean "no usage recorded".
pub(crate) fn usage_from_json(raw: &str) -> Option<TokenUsage> {
    let usage: TokenUsage = serde_json::from_str(raw).ok()?;
    (!usage.is_empty()).then_some(usage)
}

/// Serialize usage for the JSON column (`{}` when nothing was measured).
pub(crate) fn usage_to_json(usage: Option<TokenUsage>) -> String {
    usage
        .filter(|usage| !usage.is_empty())
        .and_then(|usage| serde_json::to_string(&usage).ok())
        .unwrap_or_else(|| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interact_event_serializes_to_frontend_contract() {
        let event = ChatEvent::Interact {
            interact: crate::agent::harness::InteractionView {
                kind: "clarify".to_string(),
                question: "选哪个方案？".to_string(),
                options: Some(vec![crate::agent::harness::InteractionOption {
                    label: "方案A".to_string(),
                    value: "A".to_string(),
                }]),
                fields: None,
                context: None,
            },
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["type"], "interact");
        assert_eq!(value["interact"]["kind"], "clarify");
        assert_eq!(value["interact"]["question"], "选哪个方案？");
        assert_eq!(value["interact"]["options"][0]["label"], "方案A");
        assert_eq!(value["interact"]["options"][0]["value"], "A");
        assert!(value["interact"].get("fields").is_none());
        assert!(value["interact"].get("context").is_none());
    }

    #[test]
    fn interaction_field_and_artifact_event_serialize_for_frontend() {
        let view = crate::agent::harness::InteractionView {
            kind: "form".to_string(),
            question: "补充信息".to_string(),
            options: None,
            fields: Some(vec![crate::agent::harness::InteractionField {
                name: "email".to_string(),
                label: "邮箱".to_string(),
                field_type: "email".to_string(),
                required: true,
                options: None,
            }]),
            context: Some("为什么要问".to_string()),
        };
        let value = serde_json::to_value(&view).expect("serialize view");
        assert_eq!(value["fields"][0]["type"], "email");
        assert_eq!(value["fields"][0]["required"], true);

        let artifact = ChatEvent::Artifact {
            artifacts: vec![crate::workspace::resume::ExportEntry {
                name: "简历.md".to_string(),
                path: "D:/data/exports/简历.md".to_string(),
                kind: "markdown".to_string(),
                size_bytes: 12,
                modified_at: 100,
            }],
        };
        let value = serde_json::to_value(&artifact).expect("serialize artifact");
        assert_eq!(value["type"], "artifact");
        assert_eq!(value["artifacts"][0]["name"], "简历.md");
        assert_eq!(value["artifacts"][0]["sizeBytes"], 12);
        assert_eq!(value["artifacts"][0]["modifiedAt"], 100);
    }

    // -- token usage --------------------------------------------------------

    #[test]
    fn agent_run_event_serializes_usage_and_timing() {
        let event = ChatEvent::AgentRun {
            agent: "academic".to_string(),
            ok: true,
            duration_ms: 1234,
            steps: 3,
            usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 40,
                total_tokens: 140,
                cached_tokens: 60,
            }),
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["type"], "agentRun");
        assert_eq!(value["agent"], "academic");
        assert_eq!(value["ok"], true);
        assert_eq!(value["durationMs"], 1234);
        assert_eq!(value["steps"], 3);
        assert_eq!(value["usage"]["cachedTokens"], 60);
    }

    #[test]
    fn usage_event_serializes_to_frontend_contract() {
        let event = ChatEvent::Usage {
            usage: TokenUsage {
                input_tokens: 1200,
                output_tokens: 300,
                total_tokens: 1500,
                cached_tokens: 200,
            },
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["type"], "usage");
        assert_eq!(value["usage"]["inputTokens"], 1200);
        assert_eq!(value["usage"]["outputTokens"], 300);
        assert_eq!(value["usage"]["totalTokens"], 1500);
        assert_eq!(value["usage"]["cachedTokens"], 200);
    }

    #[test]
    fn usage_json_column_roundtrips_and_blank_is_none() {
        let usage = TokenUsage {
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46,
            cached_tokens: 0,
        };
        let raw = usage_to_json(Some(usage));
        assert_eq!(usage_from_json(&raw), Some(usage), "column JSON round-trips");
        assert_eq!(usage_from_json("{}"), None);
        assert_eq!(usage_from_json(""), None);
        assert_eq!(usage_from_json("not json"), None);
        assert_eq!(usage_to_json(None), "{}");
        // All-zero usage is indistinguishable from no usage: keep it empty
        // so the UI never renders a meaningless 0/0/0 footnote.
        assert_eq!(usage_to_json(Some(TokenUsage::default())), "{}");
        assert_eq!(usage_from_json(&usage_to_json(Some(TokenUsage::default()))), None);
    }
}
