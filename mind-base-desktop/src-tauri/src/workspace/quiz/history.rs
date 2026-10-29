//! Question-stem dedup history (`quiz_history`): hashing, recording, avoid-list reads.

use super::types::QuizQuestion;

/// Question stems kept in `quiz_history` for dedup / avoidance.
const HISTORY_KEEP: usize = 200;

// ---------------------------------------------------------------------------
// Question-stem dedup (batch-internal + against quiz_history)
// ---------------------------------------------------------------------------

/// Stable hash of a question stem: whitespace-stripped lowercased text —
/// 「什么是 向量检索？」and「什么是向量检索？」must hash equal (dedup is a
/// recall-first filter; false merges are acceptable for question stems).
pub(crate) fn question_hash(text: &str) -> String {
    use md5::{Digest, Md5};

    let mut normalized = String::with_capacity(text.len());
    for ch in text.chars() {
        if !ch.is_whitespace() {
            for lower in ch.to_lowercase() {
                normalized.push(lower);
            }
        }
    }
    let mut hasher = Md5::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Insert generated stems into the dedup history; returns rows newly added.
/// Keeps the table bounded by dropping the oldest rows beyond [`HISTORY_KEEP`].
pub(super) fn record_questions(conn: &rusqlite::Connection, questions: &[QuizQuestion]) -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let mut inserted = 0usize;
    for question in questions {
        let hash = question_hash(&question.question);
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO quiz_history(question_hash, question_type, question_text, created_at)
                 VALUES(?1, ?2, ?3, ?4)",
                rusqlite::params![hash, question.question_type, question.question, now],
            )
            .map(|n| n)
            .unwrap_or(0);
        inserted += changed;
    }
    let _ = conn.execute(
        "DELETE FROM quiz_history WHERE rowid NOT IN
             (SELECT rowid FROM quiz_history ORDER BY rowid DESC LIMIT ?1)",
        rusqlite::params![HISTORY_KEEP],
    );
    inserted
}

/// Stems of the most recent history entries, oldest-last (prompt avoid-list).
pub(super) fn recent_question_texts(conn: &rusqlite::Connection, limit: usize) -> Vec<String> {
    let mut statement =
        match conn.prepare("SELECT question_text FROM quiz_history ORDER BY rowid DESC LIMIT ?1") {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
    let rows = statement
        .query_map(rusqlite::params![limit as i64], |row| {
            row.get::<_, String>(0)
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    rows
}

/// Hashes of everything already asked — the hard local dedup filter.
pub(super) fn all_question_hashes(conn: &rusqlite::Connection) -> std::collections::HashSet<String> {
    let mut statement = match conn.prepare("SELECT question_hash FROM quiz_history") {
        Ok(statement) => statement,
        Err(_) => return std::collections::HashSet::new(),
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::TYPE_SINGLE;

    fn sample_question(stem: &str) -> QuizQuestion {
        QuizQuestion {
            question_id: "q1".into(),
            question_type: TYPE_SINGLE.into(),
            difficulty: "easy".into(),
            question: stem.into(),
            options: None,
            correct_answer: None,
            keywords: vec![],
            answer_template: None,
            model_answer: None,
            scoring_rubric: None,
            explanation: String::new(),
            source_snippet: String::new(),
            low_confidence: false,
        }
    }

    #[test]
    fn question_hash_collapses_whitespace_and_case() {
        assert_eq!(
            question_hash("什么是 向量检索？"),
            question_hash("什么是向量检索？")
        );
        assert_eq!(
            question_hash("  What Is  RAG? "),
            question_hash("what is rag?")
        );
        assert_ne!(question_hash("题目甲"), question_hash("题目乙"));
    }

    #[test]
    fn record_questions_dedups_and_caps_repeat_inserts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE quiz_history(
                 question_hash TEXT PRIMARY KEY,
                 question_type TEXT NOT NULL DEFAULT '',
                 question_text TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL);",
        )
        .unwrap();
        let questions = vec![
            sample_question("向量检索的作用是什么？"),
            sample_question("向量检索的 作用是什么？"), // same stem, different spacing
        ];
        assert_eq!(record_questions(&conn, &questions), 1);
        assert_eq!(record_questions(&conn, &questions), 0);
        let hashes = all_question_hashes(&conn);
        assert_eq!(hashes.len(), 1);
        assert!(hashes.contains(&question_hash("向量检索的作用是什么？")));
        assert_eq!(recent_question_texts(&conn, 10).len(), 1);
    }
}
