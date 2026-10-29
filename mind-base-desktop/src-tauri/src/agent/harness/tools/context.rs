//! Conversation context tools: recent/full history plus lazily generated compressed summaries.

use rusqlite::{Connection, OptionalExtension};
use serde_json::json;

use super::common::{lock_err, now_secs_helper, optional_int, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

/// Recent-context default/caps (backend: n_messages clamps).
const RECENT_DEFAULT: i64 = 20;
const RECENT_MAX: i64 = 500;
const FULL_HISTORY_DEFAULT: i64 = 50;
const MESSAGE_SNIPPET_CHARS: usize = 600;
/// Compressed summaries regenerate once more than this many messages exist.
const SUMMARY_TRIGGER_COUNT: i64 = 12;

// ---------------------------------------------------------------------------
// Context trio (memory agent's storage tools)
// ---------------------------------------------------------------------------

struct ContextMessage {
    role: String,
    content: String,
}

fn fetch_recent_messages(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<ContextMessage>, String> {
    let mut statement = conn
        .prepare(
            "SELECT role, content FROM (
                 SELECT role, content, created_at FROM chat_messages
                 WHERE chat_session_id = ?1 AND status = 'completed'
                 ORDER BY created_at DESC LIMIT ?2
             ) ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to read history: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![session_id, limit], |row| {
            Ok(ContextMessage {
                role: row.get(0)?,
                content: row.get(1)?,
            })
        })
        .map_err(|err| format!("failed to query history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to map history: {err}"))
}

fn role_label(role: &str) -> &'static str {
    match role {
        "user" => "用户",
        "assistant" => "助手",
        _ => "系统",
    }
}

fn render_messages(messages: &[ContextMessage]) -> String {
    messages
        .iter()
        .map(|message| {
            let trimmed: String = message
                .content
                .chars()
                .take(MESSAGE_SNIPPET_CHARS)
                .collect();
            format!("[{}] {}", role_label(&message.role), trimmed)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) struct GetRecentContextTool;

impl LocalTool for GetRecentContextTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_RECENT_CONTEXT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let n = optional_int(arguments, "n_messages").unwrap_or(RECENT_DEFAULT);
        let n = n.clamp(1, RECENT_MAX);
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let messages = fetch_recent_messages(&conn, &ctx.session_id, n)?;
        Ok(ToolOutput::text(format!(
            "【最近对话记录 — 本地】\n{}",
            render_messages(&messages)
        )))
    }
}

static SPEC_RECENT_CONTEXT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "get_recent_context",
        "获取当前会话最近的对话记录（内存态）。",
        json!({
            "type": "object",
            "properties": {
                "n_messages": { "type": "integer", "description": "条数，默认 20" }
            }
        }),
    )
});

pub(crate) struct GetFullHistoryTool;

impl LocalTool for GetFullHistoryTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_FULL_HISTORY
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let n = optional_int(arguments, "n_messages").unwrap_or(FULL_HISTORY_DEFAULT);
        let n = n.clamp(1, RECENT_MAX);
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let messages = fetch_recent_messages(&conn, &ctx.session_id, n)?;
        Ok(ToolOutput::text(format!(
            "【完整历史记录 — 本地】\n{}",
            render_messages(&messages)
        )))
    }
}

static SPEC_FULL_HISTORY: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "get_full_history",
        "获取当前会话的完整历史记录（上限 500 条）。",
        json!({
            "type": "object",
            "properties": {
                "n_messages": { "type": "integer", "description": "条数，默认 50" }
            }
        }),
    )
});

// ---------------------------------------------------------------------------
// get_compressed_summary (+ lazy generation)
// ---------------------------------------------------------------------------

/// Generate a compressed summary of the session's older messages via the
/// chat model. Best-effort: any failure returns Err and the tool reports it
/// back to the calling agent instead of aborting the turn.
fn generate_summary(
    ctx: &ToolContext,
    chat_client: &crate::llm::client::ChatClient,
) -> Result<String, String> {
    let (older_text, kept_count, compressed_count) = {
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages
                 WHERE chat_session_id = ?1 AND status = 'completed'",
                rusqlite::params![&ctx.session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("failed to count messages: {err}"))?
            .unwrap_or_default();
        if total <= SUMMARY_TRIGGER_COUNT {
            return Err("当前会话消息不多，无需压缩摘要".to_string());
        }
        let messages = fetch_recent_messages(&conn, &ctx.session_id, total.min(200))?;
        let split_at = messages.len() - 6;
        let older = &messages[..split_at];
        let text = render_messages(older);
        (text, total - older.len() as i64, older.len() as i64)
    };

    let messages = [
        crate::llm::client::ChatMessage::new(
            "system",
            "你是对话摘要器。把提供的对话压缩为不超过300字的要点摘要，\
             保留关键事实、结论与未尽事项。只输出摘要本身。",
        ),
        crate::llm::client::ChatMessage::new("user", older_text),
    ];
    // 直连失败自动走代理（与对话流一致）。
    let summary = chat_client.complete_turn(std::time::Duration::from_secs(30), &messages)?;

    let conn = ctx.db.conn.lock().map_err(lock_err)?;
    conn.execute(
        "INSERT INTO session_summaries(session_id, summary, kept_count, compressed_count, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id) DO UPDATE SET
             summary = excluded.summary,
             kept_count = excluded.kept_count,
             compressed_count = excluded.compressed_count,
             updated_at = excluded.updated_at",
        rusqlite::params![
            &ctx.session_id,
            summary,
            kept_count,
            compressed_count,
            now_secs_helper()
        ],
    )
    .map_err(|err| format!("failed to store summary: {err}"))?;
    Ok(summary)
}


/// A cached summary is considered stale once this many new messages piled
/// up after it was generated (plan/1.0.10-AgentMemory Phase 3).
const SUMMARY_STALE_AFTER: i64 = 10;

pub(crate) struct GetCompressedSummaryTool;

impl LocalTool for GetCompressedSummaryTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_COMPRESSED_SUMMARY
    }

    fn execute(&self, ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        // (summary, kept_count, total) — kept_count is the message count at
        // generation time; a pile-up of newer messages makes it stale.
        let cached: Option<(String, i64, i64)> = {
            let conn = ctx.db.conn.lock().map_err(lock_err)?;
            conn.query_row(
                "SELECT s.summary, s.kept_count,
                        (SELECT COUNT(*) FROM chat_messages
                         WHERE chat_session_id = s.session_id AND status = 'completed')
                 FROM session_summaries s WHERE s.session_id = ?1",
                rusqlite::params![&ctx.session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| format!("failed to read summary: {err}"))?
        };

        match cached {
            // Fresh enough: serve the cache.
            Some((summary, kept_count, total)) if total - kept_count < SUMMARY_STALE_AFTER => Ok(
                ToolOutput::text(format!("【历史记忆 — 本地缓存】\n{summary}")),
            ),
            // Stale or absent: regenerate when a chat client is available.
            other => {
                let Some(chat_client) = ctx.chat_client.as_deref() else {
                    return match other {
                        Some((summary, kept_count, total)) => Ok(ToolOutput::text(format!(
                            "【历史记忆 — 压缩摘要（已过期：摘要覆盖到第 {kept_count} 条，其后有 {} 条新消息，当前无法重新生成）】\n{summary}",
                            total - kept_count
                        ))),
                        None => Ok(ToolOutput::text(
                            "【历史记忆 — 压缩摘要】暂无缓存摘要，且当前无法生成。".to_string(),
                        )),
                    };
                };
                let summary = generate_summary(ctx, chat_client)?;
                Ok(ToolOutput::text(format!(
                    "【历史记忆 — 压缩摘要（已按最新消息重算）】\n{summary}"
                )))
            }
        }
    }
}

static SPEC_COMPRESSED_SUMMARY: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "get_compressed_summary",
        "获取更早对话的压缩摘要（首次调用时会自动生成并缓存）。",
        json!({ "type": "object", "properties": {} }),
    )
});
