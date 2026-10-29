//! Persisted quiz sets: `quiz_sets` table read/write behind the `quiz_set_*` commands.

use tauri::AppHandle;

use crate::infra::db::Db;

use super::types::{
    QuizGenerateRequest, QuizQuestion, QuizRecordItem, QuizSet, QuizSetCreateRequest,
    QuizSetMeta,
};

// ---------------------------------------------------------------------------
// Quiz sets (persisted history: every generated batch, answered or not)
// ---------------------------------------------------------------------------

/// Persist one freshly generated batch as a new set; returns the set id.
#[tauri::command]
pub async fn quiz_set_create(
    app: AppHandle,
    request: QuizSetCreateRequest,
) -> Result<String, String> {
    use tauri::Manager;

    if request.questions.is_empty() {
        return Err("题集没有题目，无需保存".to_string());
    }
    let id = crate::infra::db::local_id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let config = serde_json::to_string(&request.config)
        .map_err(|err| format!("序列化出题配置失败：{err}"))?;
    let questions = serde_json::to_string(&request.questions)
        .map_err(|err| format!("序列化题目失败：{err}"))?;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "INSERT INTO quiz_sets(id, created_at, difficulty, question_count, config, questions)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            now,
            request.config.difficulty,
            request.questions.len() as i64,
            config,
            questions
        ],
    )
    .map_err(|err| format!("failed to save quiz set: {err}"))?;
    Ok(id)
}

/// List sets, newest first.
#[tauri::command]
pub async fn quiz_set_list(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<QuizSetMeta>, String> {
    use tauri::Manager;

    let limit = limit.unwrap_or(50).clamp(1, 200) as i64;
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT id, created_at, difficulty, question_count, answers, graded, total_score, total_max
             FROM quiz_sets ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )
        .map_err(|err| format!("failed to list quiz sets: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, f64>(7)?,
            ))
        })
        .map_err(|err| format!("failed to list quiz sets: {err}"))?;
    let mut sets = Vec::new();
    for row in rows {
        let (id, created_at, difficulty, question_count, answers, graded, total_score, total_max) =
            row.map_err(|err| format!("failed to read quiz set: {err}"))?;
        let answered_count =
            serde_json::from_str::<std::collections::HashMap<String, String>>(&answers)
                .map(|map| {
                    map.values()
                        .filter(|answer| !answer.trim().is_empty())
                        .count() as i64
                })
                .unwrap_or(0);
        sets.push(QuizSetMeta {
            id,
            created_at,
            difficulty,
            question_count,
            answered_count,
            graded: graded != 0,
            total_score,
            total_max,
        });
    }
    Ok(sets)
}

/// Load one set in full. Returns None when the id is unknown.
#[tauri::command]
pub async fn quiz_set_get(app: AppHandle, id: String) -> Result<Option<QuizSet>, String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let row = conn.query_row(
        "SELECT id, created_at, difficulty, question_count, config, questions, answers,
                results, graded, total_score, total_max
         FROM quiz_sets WHERE id = ?1",
        rusqlite::params![id.trim()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, f64>(9)?,
                row.get::<_, f64>(10)?,
            ))
        },
    );
    let (
        id,
        created_at,
        difficulty,
        question_count,
        config,
        questions,
        answers,
        results,
        graded,
        total_score,
        total_max,
    ) = match row {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => return Err(format!("failed to load quiz set: {err}")),
    };
    // Migrated rows (from old quiz_records) carry an empty config string —
    // their count/difficulty columns still describe the batch.
    let config: QuizGenerateRequest = if config.trim().is_empty() {
        QuizGenerateRequest {
            count: question_count.max(0) as usize,
            types: Vec::new(),
            difficulty: difficulty.clone(),
            topic: None,
        }
    } else {
        serde_json::from_str(&config).map_err(|err| format!("解析出题配置失败：{err}"))?
    };
    let questions: Vec<QuizQuestion> =
        serde_json::from_str(&questions).map_err(|err| format!("解析题目失败：{err}"))?;
    let answers: std::collections::HashMap<String, String> =
        serde_json::from_str(&answers).map_err(|err| format!("解析作答失败：{err}"))?;
    let results: Vec<QuizRecordItem> = if results.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&results).map_err(|err| format!("解析批改结果失败：{err}"))?
    };
    Ok(Some(QuizSet {
        id,
        created_at,
        difficulty,
        question_count,
        config,
        questions,
        answers,
        results,
        graded: graded != 0,
        total_score,
        total_max,
    }))
}

/// Persist in-progress answers for one set (debounced by the UI).
#[tauri::command]
pub async fn quiz_set_save_answers(
    app: AppHandle,
    id: String,
    answers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use tauri::Manager;

    let answers =
        serde_json::to_string(&answers).map_err(|err| format!("序列化作答失败：{err}"))?;
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "UPDATE quiz_sets SET answers = ?2 WHERE id = ?1",
        rusqlite::params![id.trim(), answers],
    )
    .map_err(|err| format!("failed to save answers: {err}"))?;
    Ok(())
}

/// Finish one set: store grading outcomes (question order) and totals.
#[tauri::command]
pub async fn quiz_set_finish(
    app: AppHandle,
    id: String,
    items: Vec<QuizRecordItem>,
) -> Result<(), String> {
    use tauri::Manager;

    if items.is_empty() {
        return Err("没有可保存的批改结果".to_string());
    }
    let results =
        serde_json::to_string(&items).map_err(|err| format!("序列化批改结果失败：{err}"))?;
    let total_score: f64 = items.iter().map(|item| item.score).sum();
    let total_max: f64 = items.iter().map(|item| item.max_score).sum();
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let changed = conn
        .execute(
            "UPDATE quiz_sets
             SET results = ?2, graded = 1, total_score = ?3, total_max = ?4
             WHERE id = ?1",
            rusqlite::params![id.trim(), results, total_score, total_max],
        )
        .map_err(|err| format!("failed to finish quiz set: {err}"))?;
    if changed == 0 {
        return Err("题集不存在".to_string());
    }
    Ok(())
}

/// Delete one set.
#[tauri::command]
pub async fn quiz_set_delete(app: AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "DELETE FROM quiz_sets WHERE id = ?1",
        rusqlite::params![id.trim()],
    )
    .map_err(|err| format!("failed to delete quiz set: {err}"))?;
    Ok(())
}
