//! Quiz DTOs (question / set / generation payloads) and the shared type caps.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Panel-facing caps (backend allows batches of 20; the UI stays smaller).
pub(crate) const MAX_QUESTIONS: usize = 10;

pub(crate) const TYPE_SINGLE: &str = "single_choice";
pub(crate) const TYPE_MULTI: &str = "multi_choice";
pub(crate) const TYPE_SHORT: &str = "short_answer";
pub(crate) const TYPE_ESSAY: &str = "essay";
pub(super) const ALL_TYPES: [&str; 4] = [TYPE_SINGLE, TYPE_MULTI, TYPE_SHORT, TYPE_ESSAY];

pub(crate) const DIFFICULTIES: [&str; 3] = ["easy", "medium", "hard"];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// One rubric step for essay grading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RubricItem {
    pub description: String,
    pub max_points: f64,
}

/// One generated question. Answer material rides along so the (local) UI can
/// grade without a second round-trip — it is never rendered before submit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizQuestion {
    pub question_id: String,
    /// single_choice | multi_choice | short_answer | essay
    pub question_type: String,
    pub difficulty: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// Choice types: the correct label letter(s), e.g. "B" or ["A","C"].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct_answer: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scoring_rubric: Option<Vec<RubricItem>>,
    pub explanation: String,
    pub source_snippet: String,
    pub low_confidence: bool,
}

impl QuizQuestion {
    /// Max points across the grading scheme of this question.
    pub(crate) fn max_points(&self) -> f64 {
        match self.question_type.as_str() {
            TYPE_ESSAY => self
                .scoring_rubric
                .as_ref()
                .map(|rubric| rubric.iter().map(|item| item.max_points).sum())
                .unwrap_or(10.0),
            _ => 1.0,
        }
    }
}

/// Grading outcome for one answered question.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeOutcome {
    pub question_id: String,
    pub correct: bool,
    pub score: f64,
    pub max_score: f64,
    pub feedback: String,
}

// ---------------------------------------------------------------------------
// Source chunks
// ---------------------------------------------------------------------------

/// One knowledge chunk offered to the generator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub title: String,
    pub content: String,
}

/// Panel-facing generation parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizGenerateRequest {
    pub count: usize,
    pub types: Vec<String>,
    pub difficulty: String,
    /// Optional topic keyword — when present, chunks come from a semantic
    /// search instead of spread sampling across all documents.
    #[serde(default)]
    pub topic: Option<String>,
}

/// Progress pushed to the frontend during one generation run.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuizGenEvent {
    /// Sampling source chunks from the vector store.
    Sampling,
    /// Chunks selected; the LLM is writing the batch.
    Generating,
}

/// Outcome of one generation run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizGenerateResult {
    pub questions: Vec<QuizQuestion>,
    /// Batch-internal duplicates dropped (same stem seen twice this run).
    pub duplicates_skipped: usize,
    /// Stems already present in quiz_history that the prompt avoided —
    /// informational only.
    pub history_size: usize,
}

/// One answered question inside a graded set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizRecordItem {
    pub question_type: String,
    pub question: String,
    pub given: String,
    pub correct: bool,
    pub score: f64,
    pub max_score: f64,
    pub feedback: String,
}

/// A generated question set as listed in history.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizSetMeta {
    pub id: String,
    pub created_at: i64,
    pub difficulty: String,
    pub question_count: i64,
    /// Non-empty answers among the stored answer map.
    pub answered_count: i64,
    pub graded: bool,
    pub total_score: f64,
    pub total_max: f64,
}

/// A generated question set in full (history detail view).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizSet {
    pub id: String,
    pub created_at: i64,
    pub difficulty: String,
    pub question_count: i64,
    pub config: QuizGenerateRequest,
    pub questions: Vec<QuizQuestion>,
    /// question_id -> the answer currently typed in (answering may be ongoing).
    pub answers: std::collections::HashMap<String, String>,
    /// Grading outcomes in question order; empty while ungraded.
    pub results: Vec<QuizRecordItem>,
    pub graded: bool,
    pub total_score: f64,
    pub total_max: f64,
}

/// Payload for [`quiz_set_create`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizSetCreateRequest {
    pub config: QuizGenerateRequest,
    pub questions: Vec<QuizQuestion>,
}
