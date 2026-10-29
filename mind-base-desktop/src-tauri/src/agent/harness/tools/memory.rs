//! Agent memory tools and the session blackboard (findings): long-term memory files plus session-scoped findings.

use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::json;
use tauri::Manager;

use super::common::{lock_err, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// session findings — the L2 blackboard (plan/1.0.10-AgentMemory §5).
// Sub-agents auto-deposit one signed finding per successful delegation
// (write happens in the delegate bridge, not by the agent's own will);
// every agent in the session can read them back. 20 entries per session,
// LRU-evicted.
// ---------------------------------------------------------------------------

/// Max findings kept per session (oldest evicted on insert).
const FINDINGS_MAX: usize = 20;

const FINDING_CHARS: usize = 500;
const FINDING_TOPIC_CHARS: usize = 80;

/// Deposit one structured finding for a successful delegation. Best-effort
/// by contract: callers log failures and move on. Caps the per-session rows
/// (LRU) in the same statement batch.
pub(crate) fn record_session_finding(
    conn: &Connection,
    session_id: &str,
    agent: &str,
    topic: &str,
    finding: &str,
) -> Result<(), String> {
    let topic: String = topic.chars().take(FINDING_TOPIC_CHARS).collect();
    let finding: String = finding.chars().take(FINDING_CHARS).collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO session_findings(session_id, agent, topic, finding, sources, created_at)
         VALUES(?1, ?2, ?3, ?4, '[]', ?5)",
        rusqlite::params![session_id, agent, topic, finding, now],
    )
    .map_err(|err| format!("failed to insert finding: {err}"))?;
    conn.execute(
        "DELETE FROM session_findings WHERE session_id = ?1 AND id NOT IN (
             SELECT id FROM session_findings WHERE session_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT ?2
         )",
        rusqlite::params![session_id, FINDINGS_MAX],
    )
    .map_err(|err| format!("failed to evict findings: {err}"))?;
    Ok(())
}

/// Deposit a signed finding for a successful delegation, straight from the
/// delegate bridge (the caller owns logging; failures never fail the run).
pub(crate) fn deposit_session_finding(
    handle: &tauri::AppHandle,
    session_id: &str,
    agent: &str,
    topic: &str,
    finding: &str,
) {
    let db = handle.state::<crate::infra::db::Db>();
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    if let Err(err) = record_session_finding(&conn, session_id, agent, topic, finding) {
        eprintln!("[FINDINGS] deposit failed: {err}");
    }
}

/// Render the newest findings for one session, newest first.
fn list_session_findings(conn: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT agent, topic, finding FROM session_findings
             WHERE session_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        )
        .map_err(|err| format!("failed to read findings: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![session_id, FINDINGS_MAX], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| format!("failed to query findings: {err}"))?;
    let mut lines = Vec::new();
    for (index, row) in rows.enumerate() {
        let (agent, topic, finding) =
            row.map_err(|err| format!("failed to read finding: {err}"))?;
        lines.push(format!("{}. [{agent}] {topic} → {finding}", index + 1));
    }
    Ok(lines)
}

pub(crate) struct GetSessionFindingsTool;

impl LocalTool for GetSessionFindingsTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_SESSION_FINDINGS
    }

    fn execute(&self, ctx: &ToolContext, _arguments: &str) -> Result<ToolOutput, String> {
        let conn = ctx.db.conn.lock().map_err(lock_err)?;
        let lines = list_session_findings(&conn, &ctx.session_id)?;
        if lines.is_empty() {
            return Ok(ToolOutput::text(
                "【会话黑板】暂无已沉淀的发现。".to_string(),
            ));
        }
        Ok(ToolOutput::text(format!(
            "【会话黑板 — 本会话各 agent 已沉淀的发现/契约/结论（新→旧）】\n{}",
            lines.join("\n")
        )))
    }
}

static SPEC_SESSION_FINDINGS: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "get_session_findings",
        "获取本会话中各 agent 已沉淀的结构化发现（任务结论、接口契约、决策）。与其他 agent 协作、回忆此前任务成果、避免重复劳动时调用。",
        json!({
            "type": "object",
            "properties": {}
        }),
    )
});

fn agent_memory_root(ctx: &ToolContext) -> Result<PathBuf, String> {
    let dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(dir.join("agents").join(ctx.agent.name()).join("memory"))
}

pub(crate) struct MemoryWriteTool;

impl LocalTool for MemoryWriteTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_MEMORY_WRITE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let title = super::super::registry::require_string_arg(arguments, "title")?;
        let content = super::super::registry::require_string_arg(arguments, "content")?;
        let root = agent_memory_root(ctx)?;
        ensure_memory_dirs(&root)?;
        let slug = memory_slug(&title);
        let knowledge = root.join("knowledge").join(format!("{slug}.md"));
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let span = crate::infra::store::append_section(
            &knowledge,
            &format!("<!-- {ts} -->\n## {title}\n"),
            &content,
        )?;
        crate::infra::store::append_json_line(
            &root.join("index.jsonl"),
            &json!({
                "kind": "knowledge",
                "title": title,
                "summary": content.chars().take(80).collect::<String>(),
                "file": span.file,
                "start": span.start,
                "end": span.end,
                "ts": ts,
            }),
        )
        .map_err(|err| format!("failed to index memory: {err}"))?;
        Ok(ToolOutput::text(format!(
            "已写入长期记忆：agents/{}/memory/knowledge/{slug}.md（第 {}–{} 行）",
            ctx.agent.name(),
            span.start,
            span.end
        )))
    }
}

static SPEC_MEMORY_WRITE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "memory_write",
        "把值得长期记住的经验/结论/偏好写入你自己的长期记忆（按标题归档，追加式）。写入后可在后续会话用 memory_search 检索。",
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "记忆条目标题（即主题，如「用户偏好简洁回答」）" },
                "content": { "type": "string", "description": "记忆正文（Markdown）" }
            },
            "required": ["title", "content"]
        }),
    )
});

pub(crate) struct MemorySearchTool;

impl LocalTool for MemorySearchTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_MEMORY_SEARCH
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let query = super::super::registry::require_string_arg(arguments, "query")?;
        let root = agent_memory_root(ctx)?;
        let hits = crate::infra::store::grep_parts(&root, &query)?;
        if hits.is_empty() {
            return Ok(ToolOutput::text(format!(
                "（你的长期记忆中没有匹配「{query}」的内容）"
            )));
        }
        let lines: Vec<String> = hits
            .iter()
            .map(|(file, line_no, line)| format!("- {file}:{line_no} · {line}"))
            .collect();
        Ok(ToolOutput::text(format!(
            "【长期记忆检索 — {query}】\n{}",
            lines.join("\n")
        )))
    }
}

static SPEC_MEMORY_SEARCH: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "memory_search",
        "在你的长期记忆文件中按关键词检索（子串匹配，命中带文件与行号）。回忆之前记下的经验/结论时调用。",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "要检索的关键词" }
            },
            "required": ["query"]
        }),
    )
});

fn ensure_memory_dirs(root: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(root.join("knowledge"))
        .map_err(|err| format!("cannot create memory dirs: {err}"))
}

/// File-name slug: keep word characters + CJK, everything else collapses to
/// `-`; capped so the file name stays manageable.
fn memory_slug(title: &str) -> String {
    let mut slug = String::new();
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch);
        } else if ch == ' ' {
            slug.push('-');
        }
        if slug.chars().count() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        conn
    }

    #[test]
    fn findings_record_evicts_oldest_beyond_cap_and_reads_newest_first() {
        let conn = memory_db();
        for i in 0..25 {
            record_session_finding(
                &conn,
                "s1",
                "code",
                &format!("topic{i}"),
                &format!("finding{i}"),
            )
            .expect("record");
        }
        // Another session must be untouched by s1's LRU window.
        record_session_finding(&conn, "s2", "note", "other", "finding").expect("record");

        let lines = list_session_findings(&conn, "s1").expect("list");
        assert_eq!(lines.len(), FINDINGS_MAX);
        assert!(lines[0].contains("topic24"), "newest first: {}", lines[0]);
        assert!(lines[FINDINGS_MAX - 1].contains("topic5"), "oldest kept");
        let joined = lines.join("\n");
        assert!(!joined.contains("topic0"), "oldest evicted");
        assert!(!joined.contains("other"), "sessions are isolated");

        let other = list_session_findings(&conn, "s2").expect("list s2");
        assert_eq!(other.len(), 1);
        assert!(other[0].contains("[note]"));
    }

    #[test]
    fn findings_truncate_topic_and_body() {
        let conn = memory_db();
        let long_topic = "长".repeat(300);
        let long_finding = "细".repeat(2000);
        record_session_finding(&conn, "s", "code", &long_topic, &long_finding).expect("record");
        let lines = list_session_findings(&conn, "s").expect("list");
        assert!(lines[0].contains(&"长".repeat(FINDING_TOPIC_CHARS)));
        assert!(lines[0].contains(&"细".repeat(FINDING_CHARS)));
        assert!(!lines[0].contains(&"细".repeat(FINDING_CHARS + 1)));
    }
}
