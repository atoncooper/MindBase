//! Generation/grade IPC commands (`app/commands.rs` registers them).

use tauri::{AppHandle, Manager};

use crate::infra::db::Db;

use super::generate::{fetch_chunks, generate_batch};
use super::grade::grade_question;
use super::history::{all_question_hashes, recent_question_texts, record_questions};
use super::types::{
    GradeOutcome, KnowledgeChunk, QuizGenEvent, QuizGenerateRequest, QuizGenerateResult,
    QuizQuestion, ALL_TYPES, DIFFICULTIES, MAX_QUESTIONS,
};

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Recent stems injected into the generation prompt as an avoid-list.
const HISTORY_AVOID_IN_PROMPT: usize = 12;

/// Sample the knowledge-base chunks that will feed the generator.
#[tauri::command]
pub async fn quiz_source_chunks(
    app: AppHandle,
    topic: Option<String>,
    count: Option<usize>,
) -> Result<Vec<KnowledgeChunk>, String> {
    let count = count.unwrap_or(6).clamp(1, 12);
    let embed_client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        crate::llm::embeddings::embed_client_from_conn(&conn).ok()
    };
    let handle = app.clone();
    let topic_owned = topic.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fetch_chunks(
            handle.state::<Db>().inner(),
            embed_client.as_ref(),
            topic_owned.as_deref(),
            count,
        )
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// Generate one batch of questions from the local knowledge base.
#[tauri::command]
pub async fn quiz_generate(
    app: AppHandle,
    request: QuizGenerateRequest,
    on_event: tauri::ipc::Channel<QuizGenEvent>,
) -> Result<QuizGenerateResult, String> {
    use tauri::Manager;

    let count = request.count.clamp(1, MAX_QUESTIONS);
    if !DIFFICULTIES.contains(&request.difficulty.as_str()) {
        return Err(format!(
            "难度无效：{}（可选 {}）",
            request.difficulty,
            DIFFICULTIES.join("/")
        ));
    }
    let types: Vec<String> = {
        let requested: Vec<String> = request
            .types
            .iter()
            .filter(|t| ALL_TYPES.contains(&t.as_str()))
            .cloned()
            .collect();
        if requested.is_empty() {
            ALL_TYPES.iter().map(|t| t.to_string()).collect()
        } else {
            requested
        }
    };

    // Clients resolved up front (short lock); chunk sourcing may hit network.
    let (embed_client, chat_client) = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        (
            crate::llm::embeddings::embed_client_from_conn(&conn).ok(),
            crate::llm::client::chat_client_from_conn(&conn)?.ok_or_else(|| {
                "未配置对话模型，请先在「API 设置」中填写 DashScope 或 OpenRouter Key".to_string()
            })?,
        )
    };

    let _ = on_event.send(QuizGenEvent::Sampling);
    let handle = app.clone();
    let topic = request.topic.clone();
    let (result, history_size) = tauri::async_runtime::spawn_blocking(move || {
        let chunks = fetch_chunks(
            handle.state::<Db>().inner(),
            embed_client.as_ref(),
            topic.as_deref(),
            count,
        )?;
        // Avoid-list (prompt) + hard filter (all history hashes) both
        // come from quiz_history.
        let (recent_stems, history_hashes) = {
            let db = handle.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            (
                recent_question_texts(&conn, HISTORY_AVOID_IN_PROMPT),
                all_question_hashes(&conn),
            )
        };
        let history_size = history_hashes.len();
        let _ = on_event.send(QuizGenEvent::Generating);
        let batch = generate_batch(
            &chat_client,
            &chunks,
            count,
            &types,
            &request.difficulty,
            &recent_stems,
            &history_hashes,
        )?;
        // Record the fresh stems so the NEXT run avoids them.
        let inserted = {
            let db = handle.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            record_questions(&conn, &batch.questions)
        };
        Ok::<_, String>((batch, history_size + inserted))
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;

    Ok(QuizGenerateResult {
        questions: result.questions,
        duplicates_skipped: result.duplicates_skipped,
        history_size,
    })
}

/// Grade one answered question. The full question travels back from the UI
/// (it holds the answer material privately).
#[tauri::command]
pub async fn quiz_grade(
    app: AppHandle,
    question: QuizQuestion,
    answer: String,
) -> Result<GradeOutcome, String> {
    if answer.trim().is_empty() {
        return Err("请先作答再提交".to_string());
    }
    let chat_client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        crate::llm::client::chat_client_from_conn(&conn)?
    };
    Ok(grade_question(chat_client.as_ref(), &question, &answer))
}
