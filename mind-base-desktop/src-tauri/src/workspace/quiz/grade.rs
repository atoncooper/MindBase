//! Grading: objective types locally, short answers by keyword coverage, essays by LLM rubric.

use serde_json::Value;

use crate::llm::client::{ChatClient, ChatMessage};

use super::parse::clamp_chars;
use super::types::{GradeOutcome, QuizQuestion, TYPE_ESSAY, TYPE_MULTI, TYPE_SHORT, TYPE_SINGLE};

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/// Grade one answered question: choice types locally, short_answer by
/// keyword coverage, essay via LLM rubric scoring.
pub(crate) fn grade_question(
    chat_client: Option<&ChatClient>,
    question: &QuizQuestion,
    answer: &str,
) -> GradeOutcome {
    let max_score = question.max_points();
    let base = |correct: bool, score: f64, feedback: String| GradeOutcome {
        question_id: question.question_id.clone(),
        correct,
        score,
        max_score,
        feedback,
    };

    match question.question_type.as_str() {
        TYPE_SINGLE | TYPE_MULTI => {
            let expected = question.correct_answer.clone().unwrap_or(Value::Null);
            let expected_text = letters_as_sorted_string(&expected);
            let given = letters_as_sorted_string(&Value::String(answer.to_string()));
            let correct = expected_text == given && !given.is_empty();
            base(correct, if correct { 1.0 } else { 0.0 }, String::new())
        }
        TYPE_SHORT => {
            let lowered_answer = answer.to_lowercase();
            let total = question.keywords.len().max(1);
            let covered = question
                .keywords
                .iter()
                .filter(|keyword| lowered_answer.contains(&keyword.to_lowercase()))
                .count();
            let ratio = covered as f64 / total as f64;
            let missed: Vec<String> = question
                .keywords
                .iter()
                .filter(|keyword| !lowered_answer.contains(&keyword.to_lowercase()))
                .cloned()
                .collect();
            let correct = ratio >= 0.6;
            let feedback = if missed.is_empty() {
                String::new()
            } else {
                format!("未覆盖关键词：{}", missed.join("、"))
            };
            base(correct, if correct { 1.0 } else { ratio }, feedback)
        }
        TYPE_ESSAY => {
            let Some(chat_client) = chat_client else {
                return base(
                    false,
                    0.0,
                    "未配置对话模型，无法自动评分；请对照参考答案自评。".to_string(),
                );
            };
            grade_essay(chat_client, question, answer)
        }
        other => base(false, 0.0, format!("未知题型：{other}")),
    }
}

fn letters_as_sorted_string(value: &Value) -> String {
    // Accept any case ("a" == "A") and normalize to sorted uppercase.
    let raw: String = match value {
        Value::String(text) => text.chars().collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .flat_map(str::chars)
            .collect(),
        _ => String::new(),
    };
    let mut letters: Vec<char> = raw
        .chars()
        .map(|c| c.to_ascii_uppercase())
        .filter(|c| c.is_ascii_uppercase())
        .collect();
    letters.sort();
    letters.dedup();
    letters.into_iter().collect()
}

fn grade_essay(chat_client: &ChatClient, question: &QuizQuestion, answer: &str) -> GradeOutcome {
    let max_score = question.max_points();
    let rubric_text = question
        .scoring_rubric
        .as_ref()
        .map(|rubric| {
            rubric
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    format!("{}. {}（{}分）", i + 1, item.description, item.max_points)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| "按内容完整性整体评分".to_string());

    let system = "你是严格的阅卷老师。依据评分标准对学生答案打分。只输出 JSON：\
                  {\"step_scores\":[{\"description\":\"…\",\"score\":n,\"max\":n}],\
                  \"total_score\":n,\"feedback\":\"总体评语\"}。score 不得超过对应 max。";
    let user = format!(
        "<question_text>{}</question_text>\n<scoring_rubric>{}</scoring_rubric>\n\
         <model_answer>{}</model_answer>\n<student_answer>{}</student_answer>",
        question.question,
        rubric_text,
        question.model_answer.clone().unwrap_or_default(),
        clamp_chars(answer, 4000)
    );

    // Grading failure is surfaced to the caller for a manual retry, so only
    // the primary egress route (proxy when configured) is attempted here.
    let agent_result = crate::llm::api_keys::egress_agents(
        std::time::Duration::from_secs(60),
        chat_client.endpoint_url(),
    )
    .map(|(primary, _)| primary);
    let outcome = (|| -> Result<(bool, f64, String), String> {
        let agent = agent_result?;
        let messages = [
            ChatMessage::new("system", system),
            ChatMessage::new("user", user),
        ];
        let reply = chat_client.complete_with(&agent, &messages)?;
        let value: Value =
            serde_json::from_str(&reply).map_err(|err| format!("解析评分失败：{err}"))?;
        let total = value
            .get("total_score")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let total = total.clamp(0.0, max_score);
        let feedback = value
            .get("feedback")
            .and_then(|f| f.as_str())
            .unwrap_or_default()
            .to_string();
        let correct = max_score > 0.0 && total >= max_score * 0.6;
        Ok((correct, total, feedback))
    })();

    match outcome {
        Ok((correct, score, feedback)) => GradeOutcome {
            question_id: question.question_id.clone(),
            correct,
            score,
            max_score,
            feedback,
        },
        Err(error) => GradeOutcome {
            question_id: question.question_id.clone(),
            correct: false,
            score: 0.0,
            max_score,
            feedback: format!("自动评分失败：{error}；请对照参考答案自评。"),
        },
    }
}
