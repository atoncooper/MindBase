//! Conversation sessions + grounded streaming chat turns.
//!
//! Mirrors the backend's chat stack in local terms: `chat_sessions` /
//! `chat_messages` SQLite tables replace MySQL+Mongo; the SSE frame protocol
//! becomes a Tauri `Channel<ChatEvent>` (`chunk` → `sources` → `done`, with
//! `error` on failure and a `title` side-event for auto-naming). Retrieval
//! reuses the ingestion embedding client and vector store; the answer is one
//! streamed completion over [system, last-6-messages history, grounded user
//! turn], with 【视频标题】-style citations mirroring the backend prompt.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::db::{self, Db};
use crate::embeddings::embed_client_from_conn_opt;
use crate::ingest::KnowledgeHit;
use crate::agents::AgentKind;
use crate::llm_chat::{chat_client_from_conn, ChatClient, ChatMessage};

/// How many completed history messages ride along as conversation context
/// (backend: last 6 messages = 3 turns).
const HISTORY_WINDOW: usize = 6;
/// Sources persisted/emitted per assistant message (backend caps at 5).
const SOURCE_CAP: usize = 5;
/// Max chunks shown per video inside the context blocks (mirror `_format_docs`).
const PER_VIDEO_CHUNKS: usize = 6;
/// Titles treated as "not yet named" — user renames always win over these.
const DEFAULT_TITLES: [&str; 4] = ["", "新对话", "未命名对话", "Untitled"];
/// Max characters for any generated title.
const TITLE_MAX_CHARS: usize = 18;
/// Wall-clock cap for the LLM title refinement call.
const TITLE_TIMEOUT: Duration = Duration::from_secs(8);

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// In-flight turn cancellation flags keyed by chat session id. The harness
/// turn lock guarantees at most one live turn per session, so a session key
/// unambiguously names the turn to abort.
static TURN_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn turn_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
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
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    Chunk {
        content: String,
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

fn emit(event: &ChatEvent, channel: &Channel<ChatEvent>) {
    let _ = channel.send(event.clone());
}

/// 流式 delta 合帧器：SSE 每 token 一次回调，若逐条跨 IPC 会以每秒上百次
/// 的频率轰击 webview（序列化 + 全列表重渲染），表现为卡顿掉帧。这里把
/// delta 缓冲进 50ms 一帧再发送，IPC 次数下降两个数量级，肉眼依旧流畅。
struct DeltaBatcher {
    channel: Channel<ChatEvent>,
    buffer: String,
    last_flush: std::time::Instant,
    interval: std::time::Duration,
}

impl DeltaBatcher {
    fn new(channel: Channel<ChatEvent>) -> Self {
        Self {
            channel,
            buffer: String::new(),
            last_flush: std::time::Instant::now(),
            interval: std::time::Duration::from_millis(50),
        }
    }

    fn push(&mut self, delta: &str) {
        self.buffer.push_str(delta);
        if self.last_flush.elapsed() >= self.interval {
            self.flush();
        }
    }

    /// 帧结束必须调用：把残余缓冲发出去，避免最后一截文字滞留。
    fn flush(&mut self) {
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

fn get_session_conn(conn: &Connection, session_id: &str) -> Result<Option<ChatSessionRow>, String> {
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

fn touch_session_conn(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?2, last_message_at = ?2 WHERE chat_session_id = ?1",
        params![session_id, now_secs()],
    )
    .map_err(|err| format!("failed to touch chat session: {err}"))?;
    Ok(())
}

/// Update the title only while it still carries a default name — an explicit
/// user rename always wins (mirrors backend `update_title_if_default`).
fn guarded_update_title_conn(conn: &Connection, session_id: &str, title: &str) -> bool {
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

fn insert_message_conn(
    conn: &Connection,
    msg_id: &str,
    session_id: &str,
    role: &str,
    content: &str,
    status: &str,
    model: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO chat_messages(msg_id, chat_session_id, role, content, status, sources, model, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7)",
        params![msg_id, session_id, role, content, status, model, now_secs()],
    )
    .map_err(|err| format!("failed to save message: {err}"))?;
    Ok(())
}

fn fail_assistant_message_conn(conn: &Connection, msg_id: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_messages SET status = 'failed', error = ?2 WHERE msg_id = ?1",
        params![msg_id, error],
    )
    .map_err(|err| format!("failed to mark message failed: {err}"))?;
    Ok(())
}

/// Last `limit` completed messages of a session, oldest first.
fn recent_history_conn(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<ChatMessage>, String> {
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
        .query_map(params![session_id, limit as i64], |row| {
            Ok(ChatMessage::new(
                row.get::<_, String>(0)?.as_str(),
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|err| format!("failed to query history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to map history: {err}"))
}

// ---------------------------------------------------------------------------
// Prompt / formatting (pure)
// ---------------------------------------------------------------------------

/// True when a hit's chunk belongs to the grouping key of another video.
/// Group key is the bvid; hits without one group under their doc id.
fn group_key(hit: &KnowledgeHit) -> String {
    if hit.bvid.is_empty() {
        hit.doc_id.clone()
    } else {
        hit.bvid.clone()
    }
}

/// Display heading of one video group inside the context block.
fn group_heading(hits: &[KnowledgeHit]) -> String {
    let first = &hits[0];
    if first.page_title.is_empty() {
        first.video_title.clone()
    } else {
        format!("{} · {}", first.video_title, first.page_title)
    }
}

/// Format retrieval hits into numbered-per-video context blocks, mirroring
/// `_format_docs`: grouped per video (≤ [`PER_VIDEO_CHUNKS`] each), sorted by
/// score within the group, joined by `---`.
pub(crate) fn format_context_blocks(hits: &[KnowledgeHit]) -> String {
    if hits.is_empty() {
        return "（知识库中没有找到相关内容）".to_string();
    }
    let mut groups: Vec<(String, Vec<KnowledgeHit>)> = Vec::new();
    for hit in hits {
        let key = group_key(hit);
        if let Some(group) = groups.iter_mut().find(|(existing, _)| *existing == key) {
            group.1.push(hit.clone());
        } else {
            groups.push((key, vec![hit.clone()]));
        }
    }

    let mut blocks: Vec<String> = Vec::new();
    for (_, group) in groups.iter_mut() {
        group.sort_by(|a, b| b.score.total_cmp(&a.score));
        let heading = group_heading(group);
        let body = group
            .iter()
            .take(PER_VIDEO_CHUNKS)
            .map(|hit| format!("【{heading}】(相关度: {:.2})\n{}", hit.score, hit.content.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(body);
    }
    blocks.join("\n\n---\n\n")
}

/// Strip decoration from a raw LLM-generated title and clamp its length.
pub(crate) fn sanitize_title(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    for prefix in ["标题：", "标题:", "title:", "Title:", "《", "\"", "'"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_string();
        }
    }
    let trimmed: String = text
        .trim_matches(|c: char| {
            matches!(c, '"' | '\'' | '《' | '》' | '「' | '」' | '『' | '』' | '。' | '！' | '？' | ' ')
        })
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(TITLE_MAX_CHARS)
        .collect();
    trimmed
}

/// Fallback title: first non-space chars of the first message.
pub(crate) fn fallback_title(first_message: &str) -> String {
    let squeezed: String = first_message.split_whitespace().collect::<Vec<_>>().join("");
    let title: String = squeezed.chars().take(TITLE_MAX_CHARS).collect();
    if title.is_empty() {
        "新对话".to_string()
    } else {
        title
    }
}

fn is_default_title(title: &str) -> bool {
    DEFAULT_TITLES.contains(&title.trim())
}

/// Dedupe hits by bvid (keep highest score) and cap the list — mirrors the
/// backend `_extract_sources` behavior at the message level.
pub(crate) fn collect_sources(hits: &[KnowledgeHit]) -> Vec<ChatSource> {
    let mut best: Vec<(String, ChatSource)> = Vec::new();
    for hit in hits {
        if hit.url.is_empty() {
            continue;
        }
        let key = if hit.bvid.is_empty() {
            hit.doc_id.clone()
        } else {
            hit.bvid.clone()
        };
        let source = ChatSource {
            title: hit.video_title.clone(),
            page_title: hit.page_title.clone(),
            score: hit.score,
            bvid: hit.bvid.clone(),
            url: hit.url.clone(),
            page_index: hit.page_index,
        };
        match best.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, existing)) => {
                if hit.score > existing.score {
                    *existing = source;
                }
            }
            None => best.push((key, source)),
        }
    }
    best.into_iter().map(|(_, source)| source).take(SOURCE_CAP).collect()
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
pub fn chat_session_create(db: State<'_, Db>, title: Option<String>) -> Result<ChatSessionRow, String> {
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
    get_session_conn(&conn, &session_id)?
        .ok_or_else(|| "会话创建失败".to_string())
}

#[tauri::command]
pub fn chat_session_rename(db: State<'_, Db>, session_id: String, title: String) -> Result<(), String> {
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
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    tx.execute(
        "DELETE FROM chat_messages WHERE chat_session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("failed to delete messages: {err}"))?;
    tx.execute(
        "DELETE FROM chat_sessions WHERE chat_session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("failed to delete chat session: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn chat_history(db: State<'_, Db>, session_id: String) -> Result<Vec<ChatMessageRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT msg_id, chat_session_id, role, content, status, sources, model, error, created_at
             FROM chat_messages WHERE chat_session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to load history: {err}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            let sources_raw: String = row.get(5)?;
            Ok(ChatMessageRow {
                msg_id: row.get(0)?,
                chat_session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                status: row.get(4)?,
                sources: serde_json::from_str(&sources_raw).unwrap_or(serde_json::json!([])),
                model: row.get(6)?,
                error: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|err| format!("failed to query history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read history: {err}"))
}

// ---------------------------------------------------------------------------
// summary agent — desktop port of app/agent/summary + session_summary router.
// ---------------------------------------------------------------------------

/// summary 系统提示词——四章节结构照抄主 app。
pub(crate) fn summary_system_prompt() -> String {
    "你是会话总结助手，负责对用户与 AI 助手的完整对话记录生成一份详细、结构化的总结。\n\n\
     ## 输出格式（Markdown，严格按以下四个章节）\n\n\
     ## 会话主题\n\
     一两句话概括这次会话讨论的核心内容。\n\n\
     ## 关键知识点\n\
     按话题分组列出对话中涉及的知识点。每个要点：\n\
     - 用简明的一句话描述，保留关键细节\n\
     - 如果信息来自某个视频/文档，标注其来源标题\n\n\
     ## 用户的关注点与追问\n\
     用户反复追问、澄清或特别关心的方向，以及用户在对话中给出的反馈和偏好。\n\n\
     ## 结论与未决问题\n\
     - 对话已明确得出的结论\n\
     - 尚未解决或没有明确答案的问题\n\n\
     ## 强制约束（必须遵守）\n\
     1. **忠实于对话内容**：只总结对话中实际出现的信息，不引入外部知识，不编造\n\
     2. **保留具体细节**：数字、专有名词、视频标题等关键信息原样保留\n\
     3. **忽略系统噪声**：对话中的报错、加载失败提示等无意义内容不要纳入总结\n\
     4. **输出为合法 Markdown**：使用 # 标题、- 列表、**加粗** 等标准语法\n\
     5. **语言与对话一致**：对话是中文就用中文总结"
        .to_string()
}

/// Stream a fresh structured summary of one session (chunk/done/error events).
/// Mirrors the backend's `POST /chat/sessions/{id}/summary` SSE endpoint;
/// the finished summary is persisted to `session_summary_docs` so the modal
/// can reopen instantly (backend parity: GET latest summary).
#[tauri::command]
pub async fn chat_summarize(
    app: AppHandle,
    session_id: String,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    // History + client under one short lock, then stream off the runtime.
    let (client, transcript) = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let client = chat_client_from_conn(&conn)?.ok_or_else(|| {
            "未配置任何对话模型，请先在「API 设置」中填写 DashScope 或 OpenRouter Key".to_string()
        })?;
        let mut statement = conn
            .prepare(
                "SELECT role, content FROM chat_messages
                 WHERE chat_session_id = ?1 AND status = 'completed'
                   AND role IN ('user', 'assistant')
                 ORDER BY created_at ASC",
            )
            .map_err(|err| format!("failed to load history: {err}"))?;
        let rows: Vec<(String, String)> = statement
            .query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|err| format!("failed to query history: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read history: {err}"))?;
        (client, rows)
    };

    if transcript.is_empty() {
        return Err("这个会话还没有可总结的对话内容".to_string());
    }
    let mut transcript_text = String::new();
    for (role, content) in &transcript {
        let speaker = if role == "user" { "用户" } else { "助手" };
        transcript_text.push_str(&format!("{speaker}：{content}\n\n"));
    }

    let messages = vec![
        ChatMessage::new("system", summary_system_prompt()),
        ChatMessage::new("user", format!("请总结以下对话记录：\n\n{transcript_text}")),
    ];

    let stream_channel = on_event.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut answer = String::new();
        let mut batcher = DeltaBatcher::new(stream_channel);
        let outcome = client.stream_turn(&messages, None, &mut |delta| {
            answer.push_str(delta);
            batcher.push(delta);
        }, None);
        batcher.flush();
        outcome.map(|_| answer)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?;

    match result {
        Ok(answer) => {
            // 对齐主 app：总结送达用户后落库一份，供下次打开秒开回看。
            // 落库失败不丢弃内容——只告警，下次重新生成即可覆盖。
            {
                let db = app.state::<Db>();
                let persist = db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))
                    .and_then(|conn| {
                        conn.execute(
                            "INSERT INTO session_summary_docs(session_id, content, message_count, created_at)
                             VALUES(?1, ?2, ?3, ?4)
                             ON CONFLICT(session_id) DO UPDATE SET
                               content = excluded.content,
                               message_count = excluded.message_count,
                               created_at = excluded.created_at",
                            params![session_id, answer, transcript.len() as i64, now_secs()],
                        )
                        .map_err(|err| format!("failed to persist summary: {err}"))
                    });
                if let Err(error) = persist {
                    eprintln!("[SUMMARY] persist failed session={}: {error}", &session_id[..8.min(session_id.len())]);
                }
            }
            emit(&ChatEvent::Done { msg_id: String::new() }, &on_event);
            Ok(())
        }
        Err(error) => {
            emit(&ChatEvent::Error { message: error.clone() }, &on_event);
            Err(error)
        }
    }
}

/// One persisted summary document (desktop keeps the latest per session).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummaryDoc {
    pub session_id: String,
    pub content: String,
    pub message_count: i64,
    /// Epoch seconds of the last generation.
    pub created_at: i64,
}

/// Latest persisted summary of one session; `None` = never generated.
/// Mirrors the backend's `GET /chat/sessions/{id}/summary`.
#[tauri::command]
pub fn chat_summary_get(
    app: AppHandle,
    session_id: String,
) -> Result<Option<SessionSummaryDoc>, String> {
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.query_row(
        "SELECT session_id, content, message_count, created_at
         FROM session_summary_docs WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(SessionSummaryDoc {
                session_id: row.get(0)?,
                content: row.get(1)?,
                message_count: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read summary: {err}"))
}

/// One grounded streaming turn: persist both sides, retrieve context, stream
/// the answer, finalize persistence — reporting progress via `on_event`.
/// `skill`（来自输入框 / 菜单）非空时把该技能全文作为本轮 system 指令强制注入。
#[tauri::command]
pub async fn chat_ask(
    app: AppHandle,
    session_id: String,
    question: String,
    provider: Option<String>,
    skill: Option<String>,
    on_event: Channel<ChatEvent>,
) -> Result<ChatTurnResult, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题".to_string());
    }

    // Precheck + history under one short lock.
    let (history, embed_client, chat_client, was_default_title, skill_body) = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let session = get_session_conn(&conn, &session_id)?
            .ok_or_else(|| "会话不存在".to_string())?;
        let history = recent_history_conn(&conn, &session_id, HISTORY_WINDOW)?;
        // 向量化客户端可选：只配了对话密钥（如仅 OpenRouter）时跳过检索，
        // vector_search 工具会自行给出友好提示。
        let embed_client = embed_client_from_conn_opt(&conn)?;
        let chat_client = match provider.as_deref().map(str::trim) {
            Some(p) if !p.is_empty() => Some(crate::llm_chat::chat_client_for(&conn, p)?),
            _ => chat_client_from_conn(&conn)?,
        }
        .ok_or_else(|| {
            "未配置任何对话模型，请先在「API 设置」中填写提供方密钥".to_string()
        })?;
        // 强制注入技能：显式选择无效（不存在/被禁用）时整轮报错，不静默忽略。
        let skill_body = match skill.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => {
                let dir = db
                    .data_dir
                    .lock()
                    .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
                Some(crate::skills::read_skill_body(&conn, &dir, name)?)
            }
            _ => None,
        };
        (history, embed_client, chat_client, is_default_title(&session.title), skill_body)
    };

    let assistant_msg_id = db::local_id();

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
        insert_message_conn(&tx, &db::local_id(), &session_id, "user", &question, "completed", "")?;
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
            emit(&ChatEvent::Title { title: instant_title }, &on_event);
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
    let history_for_turn = match &skill_body {
        Some(body) => {
            let mut with_skill = history.clone();
            with_skill.push(ChatMessage::new(
                "system",
                format!(
                    "## 用户强制注入的技能（本轮必须严格遵循）\n\n用户通过输入框 / 菜单显式附加了以下技能指令，其要求优先于默认行为：\n\n{body}"
                ),
            ));
            with_skill
        }
        None => history,
    };
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
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<
        crate::harness::ReactOutcome,
        String,
    > {
        let harness_arc = crate::harness::harness();

        // Route (single registered agent short-circuits without an LLM call —
        // faithful to the backend's production posture).
        let _routed = harness_arc.orchestrator.route(&chat_client, &question);

        // Lifecycle gate: breaker + per-session turn lock.
        let guard = harness_arc.lifecycle.enter("chat", &session_id);
        if guard.breaker_tripped {
            return Err(crate::harness::BREAKER_OPEN_MESSAGE.to_string());
        }
        let _turn_lock = guard
            .session_lock
            .lock()
            .map_err(|err| format!("session lock poisoned: {err}"))?;

        // Delegation bridge: children run reentrantly (no session lock) with
        // a structurally empty delegate slot (two-level cap). Consecutive
        // failures per target short-circuit after the backend's threshold.
        const DELEGATE_FAILURE_THRESHOLD: u32 = 2;
        let bridge_handle = handle.clone();
        let bridge_client = chat_client.clone();
        let bridge_embed = embed_client.clone();
        let bridge_session = session_id.clone();
        let bridge_events = event_channel.clone();
        let delegate_box: Box<crate::harness::DelegateFn> = Box::new(move |agent_name: &str, query: &str| {
            let failures =
                crate::harness::harness()
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
            match crate::harness::run_sub_agent(
                kind,
                &bridge_handle,
                &bridge_client,
                bridge_embed.as_ref(),
                &bridge_session,
                query,
                &mut on_child_step,
            ) {
                Ok(pair) => {
                    crate::harness::harness()
                        .lifecycle
                        .reset_delegate_failures(&bridge_session, agent_name);
                    Ok(pair)
                }
                Err(error) => Err(error),
            }
        });

        let db = handle.state::<Db>();
        let ctx = crate::harness::ToolContext {
            db: db.inner(),
            embed_client: embed_client.as_ref(),
            chat_client: Some(&chat_client),
            session_id: &session_id,
            delegate: Some(delegate_box.as_ref()),
        };

        let mut batcher = DeltaBatcher::new(event_channel.clone());

        // The probe runs on the streaming thread; a relaxed load is enough —
        // the flag is a one-way latch, no ordering with other data matters.
        let stop_flag = cancel_token.clone();
        let should_stop = move || stop_flag.load(Ordering::Relaxed);

        let mut callbacks = crate::harness::ReactCallbacks {
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
        };

        let outcome = crate::harness::react_loop(
            &chat_client,
            &ctx,
            AgentKind::Chat,
            &history_for_turn,
            &question,
            0,
            None,
            &mut callbacks,
        );
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
            let sources = collect_sources(&result.hits);
            if !sources.is_empty() {
                emit(&ChatEvent::Sources { sources: sources.clone() }, &on_event);
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
            // empty bubble on history reload.
            let answer = if result.answer.trim().is_empty() && result.interrupted {
                "（已手动中断本次生成）".to_string()
            } else {
                result.answer
            };
            complete_assistant_message_tx(
                &tx,
                &assistant_msg_id,
                &answer,
                &sources,
                &model_name,
            )?;
            touch_session_conn(&tx, &session_for_finalize)?;
            tx.commit()
                .map_err(|err| format!("failed to finalize turn: {err}"))?;
            emit(&ChatEvent::Done { msg_id: assistant_msg_id.clone() }, &on_event);
            Ok(ChatTurnResult {
                msg_id: assistant_msg_id,
                answer,
            })
        }
        Err(error) => {
            let db = app.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            fail_assistant_message_conn(&conn, &assistant_msg_id, &error)?;
            emit(&ChatEvent::Error { message: error.clone() }, &on_event);
            Err(error)
        }
    }
}

/// Persist the completed assistant message (content + sources JSON + model).
fn complete_assistant_message_tx(
    conn: &Connection,
    msg_id: &str,
    content: &str,
    sources: &[ChatSource],
    model: &str,
) -> Result<(), String> {
    let sources_json =
        serde_json::to_string(sources).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "UPDATE chat_messages SET status = 'completed', content = ?2, sources = ?3, model = ?4
         WHERE msg_id = ?1",
        params![msg_id, content, sources_json, model],
    )
    .map_err(|err| format!("failed to complete message: {err}"))?;
    Ok(())
}

/// Best-effort LLM title refinement off the hot path: generates a short
/// Chinese title from the first user message and applies it only while the
/// session still carries a default name.
fn spawn_title_refinement(
    handle: AppHandle,
    client: ChatClient,
    channel: Channel<ChatEvent>,
    session_id: String,
    first_message: String,
) {
    // Routed through the scheduler queue: transient timeouts get classified
    // exponential-backoff retries for free.
    let submitted = crate::harness::harness()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(doc_id: &str, bvid: &str, title: &str, page: &str, score: f32, content: &str) -> KnowledgeHit {
        KnowledgeHit {
            doc_id: doc_id.to_string(),
            chunk_index: 0,
            content: content.to_string(),
            score,
            bvid: bvid.to_string(),
            page_index: 1,
            video_title: title.to_string(),
            page_title: page.to_string(),
            url: format!("https://www.bilibili.com/video/{bvid}?p=1"),
        }
    }

    #[test]
    fn context_blocks_group_by_video_and_cap_chunks() {
        let hits = vec![
            hit("d1", "BV1", "视频A", "P1", 0.9, "A高"),
            hit("d2", "BV2", "视频B", "", 0.8, "B块"),
            hit("d3", "BV1", "视频A", "P1", 0.7, "A低"),
        ];
        let blocks = format_context_blocks(&hits);
        assert!(blocks.contains("【视频A · P1】"));
        assert!(blocks.contains("【视频B】"));
        assert!(blocks.contains("---"));
        assert!(blocks.starts_with("【视频A · P1】"), "highest-score group first content");
        assert!(blocks.find("A低").unwrap() > blocks.find("A高").unwrap(), "sorted by score in group");
    }

    #[test]
    fn empty_context_has_explicit_copy() {
        assert_eq!(format_context_blocks(&[]), "（知识库中没有找到相关内容）");
    }

    #[test]
    fn title_sanitizer_strips_decoration_and_clamps() {
        assert_eq!(sanitize_title("标题：《RAG 系统设计》！"), "RAG系统设计");
        assert_eq!(sanitize_title("\"hello world\""), "helloworld");
        let long = sanitize_title(&"很".repeat(30));
        assert_eq!(long.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(sanitize_title("   "), "");
    }

    #[test]
    fn fallback_title_squeezes_and_truncates() {
        assert_eq!(fallback_title("你好 世界"), "你好世界");
        assert_eq!(fallback_title(""), "新对话");
        assert_eq!(fallback_title(&"字 ".repeat(20)).chars().count(), TITLE_MAX_CHARS);
    }

    #[test]
    fn default_titles_match_backend_set() {
        assert!(is_default_title("新对话"));
        assert!(is_default_title(""));
        assert!(!is_default_title("我的研究计划"));
    }

    #[test]
    fn sources_dedupe_by_bvid_keeping_best_score() {
        let hits = vec![
            hit("d1", "BV1", "视频A", "P1", 0.5, "a"),
            hit("d2", "BV1", "视频A", "P2", 0.9, "b"),
            hit("d3", "BV2", "视频B", "", 0.8, "c"),
        ];
        let sources = collect_sources(&hits);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].score, 0.9, "best score kept for BV1");
        assert_eq!(sources[0].page_title, "P2", "the best-scoring hit survives");
        // Hits without a URL are dropped entirely.
        let mut no_url = hit("d4", "", "无链接", "", 1.0, "x");
        no_url.url = String::new();
        assert!(collect_sources(&[no_url]).is_empty());
    }
}
