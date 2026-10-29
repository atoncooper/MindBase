//! Session summary generation (`chat_summarize`) + latest-summary lookup.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::types::{emit, now_secs, ChatEvent, DeltaBatcher};
use crate::infra::db::Db;
use crate::llm::client::{chat_client_from_conn, ChatMessage};

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
        let outcome = client.stream_turn(
            &messages,
            None,
            &mut |delta| {
                answer.push_str(delta);
                batcher.push(delta);
            },
            None,
        );
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
                    eprintln!(
                        "[SUMMARY] persist failed session={}: {error}",
                        &session_id[..8.min(session_id.len())]
                    );
                }
            }
            emit(
                &ChatEvent::Done {
                    msg_id: String::new(),
                },
                &on_event,
            );
            Ok(())
        }
        Err(error) => {
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
