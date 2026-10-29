//! Chat session lifecycle: list/create/rename/delete, turn cancellation,
//! and best-effort title naming.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::context::{sanitize_title, DEFAULT_TITLES, TITLE_MAX_CHARS};
use super::types::{emit, now_secs, ChatEvent, ChatSessionRow};
use crate::infra::db::{self, Db};
use crate::llm::client::{ChatClient, ChatMessage};

/// Wall-clock cap for the LLM title refinement call.
const TITLE_TIMEOUT: Duration = Duration::from_secs(8);

/// In-flight turn cancellation flags keyed by chat session id. The harness
/// turn lock guarantees at most one live turn per session, so a session key
/// unambiguously names the turn to abort.
static TURN_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

pub(super) fn turn_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    TURN_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Abort the in-flight turn of one session; returns whether a turn was live.
#[tauri::command]
pub fn stop_chat(session_id: String) -> bool {
    let registry = turn_cancels()
        .lock()
        .map_err(|err| format!("cancel registry poisoned: {err}"));
    match registry {
        Ok(map) => match map.get(session_id.trim()) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

/// Epoch seconds → `YYYY-MM-DD` (UTC date), used by history citations.
/// Civil-from-days algorithm — no chrono dependency.
pub(crate) fn epoch_to_date(epoch_secs: i64) -> String {
    let secs = if epoch_secs < 0 { 0 } else { epoch_secs };
    let z = secs / 86_400 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

// ---------------------------------------------------------------------------
// Session/message persistence helpers (&Connection scoped)
// ---------------------------------------------------------------------------

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSessionRow> {
    Ok(ChatSessionRow {
        chat_session_id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        last_message_at: row.get(4)?,
    })
}

fn list_sessions_conn(conn: &Connection) -> Result<Vec<ChatSessionRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT chat_session_id, title, created_at, updated_at, last_message_at
             FROM chat_sessions WHERE status = 'active'
             ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("failed to list chat sessions: {err}"))?;
    let rows = statement
        .query_map([], row_to_session)
        .map_err(|err| format!("failed to query chat sessions: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read chat sessions: {err}"))
}

pub(super) fn get_session_conn(conn: &Connection, session_id: &str) -> Result<Option<ChatSessionRow>, String> {
    conn.query_row(
        "SELECT chat_session_id, title, created_at, updated_at, last_message_at
         FROM chat_sessions WHERE chat_session_id = ?1 AND status = 'active'",
        params![session_id],
        row_to_session,
    )
    .optional()
    .map_err(|err| format!("failed to read chat session: {err}"))
}

fn insert_session_conn(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO chat_sessions(chat_session_id, title, status, created_at, updated_at)
         VALUES(?1, ?2, 'active', ?3, ?3)",
        params![session_id, title, now],
    )
    .map_err(|err| format!("failed to create chat session: {err}"))?;
    Ok(())
}

pub(super) fn touch_session_conn(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?2, last_message_at = ?2 WHERE chat_session_id = ?1",
        params![session_id, now_secs()],
    )
    .map_err(|err| format!("failed to touch chat session: {err}"))?;
    Ok(())
}

/// Update the title only while it still carries a default name — an explicit
/// user rename always wins (mirrors backend `update_title_if_default`).
pub(super) fn guarded_update_title_conn(conn: &Connection, session_id: &str, title: &str) -> bool {
    let placeholders = DEFAULT_TITLES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE chat_sessions SET title = ?1
         WHERE chat_session_id = ?2 AND status = 'active' AND title IN ({placeholders})"
    );
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&title, &session_id];
    for default in &DEFAULT_TITLES {
        args.push(default);
    }
    matches!(conn.execute(&sql, args.as_slice()), Ok(updated) if updated > 0)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn chat_sessions_list(db: State<'_, Db>) -> Result<Vec<ChatSessionRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    list_sessions_conn(&conn)
}

#[tauri::command]
pub fn chat_session_create(
    db: State<'_, Db>,
    title: Option<String>,
) -> Result<ChatSessionRow, String> {
    let session_id = db::local_id();
    let title = match title {
        Some(title) if !title.trim().is_empty() => title.trim().to_string(),
        _ => "新对话".to_string(),
    };
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    insert_session_conn(&conn, &session_id, &title)?;
    get_session_conn(&conn, &session_id)?.ok_or_else(|| "会话创建失败".to_string())
}

#[tauri::command]
pub fn chat_session_rename(
    db: State<'_, Db>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let updated = conn
        .execute(
            "UPDATE chat_sessions SET title = ?2, updated_at = ?3
             WHERE chat_session_id = ?1 AND status = 'active'",
            params![session_id, title, now_secs()],
        )
        .map_err(|err| format!("failed to rename chat session: {err}"))?;
    if updated == 0 {
        return Err("会话不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn chat_session_delete(db: State<'_, Db>, session_id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // Cascades to summaries / summary docs / blackboard findings — no memory
    // layer may outlive its session (plan/1.0.10-AgentMemory §8.5).
    crate::infra::db::delete_session_cascade(&conn, &session_id)
}

/// Best-effort LLM title refinement off the hot path: generates a short
/// Chinese title from the first user message and applies it only while the
/// session still carries a default name.
pub(super) fn spawn_title_refinement(
    handle: AppHandle,
    client: ChatClient,
    channel: Channel<ChatEvent>,
    session_id: String,
    first_message: String,
) {
    // Routed through the scheduler queue: transient timeouts get classified
    // exponential-backoff retries for free.
    let submitted = crate::agent::harness::harness()
        .scheduler
        .submit("title-refine", move || {
            let system = "你是聊天标题生成器。请根据用户的第一条消息生成一个简短中文标题。                      只输出标题本身，不要解释，不要引号，不超过18个中文字符。                      如果是代码或技术问题，突出技术对象。";
            let messages = [ChatMessage::new("system", system), ChatMessage::new("user", &first_message)];

            // 直连失败自动走代理（与对话流一致），否则被墙网络下命名永远失败。
            let parsed = client.complete_turn(TITLE_TIMEOUT, &messages)?;
            let title = sanitize_title(&parsed);
            if title.is_empty() || title.chars().count() > TITLE_MAX_CHARS {
                return Err("生成的标题无效".to_string());
            }
            let db = handle.state::<Db>();
            let applied = {
                let conn = db.conn.lock().map_err(|err| err.to_string())?;
                guarded_update_title_conn(&conn, &session_id, &title)
            };
            if applied {
                emit(&ChatEvent::Title { title }, &channel);
            }
            Ok(String::new())
        });

    // Queue-full is fine for an auxiliary task — the instant fallback title
    // was already applied before this ran.
    if let Err(error) = submitted {
        eprintln!("[TITLE] refinement not scheduled: {error}");
    }
}
