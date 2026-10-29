//! Raw-model-output parsing / normalization into [`QuizQuestion`] and its parts.

use serde_json::Value;

use super::types::{KnowledgeChunk, QuizQuestion, RubricItem, TYPE_ESSAY, TYPE_MULTI, TYPE_SHORT, TYPE_SINGLE};

const QUESTION_CHARS_MAX: usize = 300;
const OPTION_CHARS_MAX: usize = 120;
const ESSAY_MODEL_ANSWER_MAX: usize = 800;
const SNIPPET_CHARS: usize = 500;

pub(super) fn clamp_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Extract the top-level `"questions"` array from a raw model reply.
pub(crate) fn parse_questions_reply(reply: &str) -> Result<Vec<Value>, String> {
    let trimmed = reply.trim();
    // Tolerate code fences even though the prompt forbids them.
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim_start_matches('\n')
        .trim_end_matches("```")
        .trim();
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("解析出题 JSON 失败：{err}"))?;
    let questions = value
        .get("questions")
        .and_then(|q| q.as_array())
        .ok_or("出题 JSON 缺少 questions 数组")?;
    Ok(questions.clone())
}

/// Normalize one raw question object into [`QuizQuestion`]; returns Err when
/// the item is unusable for its declared type.
pub(crate) fn normalize_question(
    raw: &Value,
    difficulty: &str,
    chunks: &[KnowledgeChunk],
) -> Result<QuizQuestion, String> {
    let q_type = raw
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or(TYPE_SINGLE)
        .to_string();
    let question_text = raw
        .get("question")
        .and_then(|q| q.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if question_text.is_empty() || question_text.chars().count() > QUESTION_CHARS_MAX {
        return Err("题干缺失或超长".to_string());
    }
    let explanation = raw
        .get("explanation")
        .and_then(|e| e.as_str())
        .unwrap_or_default()
        .to_string();

    let snippet_source = chunks.first().map(|c| c.content.as_str()).unwrap_or("");
    let base = |correct: Option<Value>| QuizQuestion {
        question_id: crate::infra::db::local_id(),
        question_type: q_type.clone(),
        difficulty: difficulty.to_string(),
        question: question_text.clone(),
        options: None,
        correct_answer: correct,
        keywords: Vec::new(),
        answer_template: None,
        model_answer: None,
        scoring_rubric: None,
        explanation,
        source_snippet: clamp_chars(snippet_source, SNIPPET_CHARS),
        low_confidence: false,
    };

    match q_type.as_str() {
        TYPE_SINGLE => {
            let options = parse_options(raw, 4, 4)?;
            let correct = parse_correct_letters(raw, &options, 1, 1)?;
            let mut question = base(Some(Value::String(correct)));
            question.options = Some(options);
            Ok(question)
        }
        TYPE_MULTI => {
            let options = parse_options(raw, 4, 6)?;
            let correct = parse_correct_letters(raw, &options, 2, 4)?;
            let mut question = base(Some(Value::String(correct)));
            question.options = Some(options);
            Ok(question)
        }
        TYPE_SHORT => {
            let keywords = string_list(raw, "keywords");
            if keywords.len() < 3 {
                return Err("short_answer 需要 ≥3 个关键词".to_string());
            }
            let template = raw
                .get("answer_template")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string();
            let mut question = base(None);
            question.keywords = keywords;
            question.answer_template = Some(clamp_chars(&template, 100));
            Ok(question)
        }
        TYPE_ESSAY => {
            let rubric = parse_rubric(raw)?;
            let model_answer = raw
                .get("model_answer")
                .and_then(|m| m.as_str())
                .unwrap_or_default()
                .to_string();
            if model_answer.is_empty() {
                return Err("essay 缺少 model_answer".to_string());
            }
            let mut question = base(None);
            question.model_answer = Some(clamp_chars(&model_answer, ESSAY_MODEL_ANSWER_MAX));
            question.scoring_rubric = Some(rubric);
            Ok(question)
        }
        other => Err(format!("未知题型：{other}")),
    }
}

fn parse_options(raw: &Value, min: usize, max: usize) -> Result<Vec<String>, String> {
    let raw_options = raw
        .get("options")
        .and_then(|o| o.as_array())
        .ok_or("缺少选项数组")?;
    if !(min..=max).contains(&raw_options.len()) {
        return Err(format!("选项数量不符（要求 {min}-{max}）"));
    }
    raw_options
        .iter()
        .map(|option| {
            // Strip an "A. " style prefix when the model added one.
            let text = option.as_str().unwrap_or_default().trim();
            let stripped = text
                .strip_prefix(['A', 'B', 'C', 'D', 'E', 'F'])
                .and_then(|rest| rest.strip_prefix(". "))
                .unwrap_or(text);
            let cleaned = clamp_chars(stripped.trim(), OPTION_CHARS_MAX);
            if cleaned.is_empty() {
                return Err("存在空选项".to_string());
            }
            Ok(cleaned)
        })
        .collect()
}

/// Parse correct letters ("B" / ["A","C"]) validating bounds and count.
fn parse_correct_letters(
    raw: &Value,
    options: &[String],
    min: usize,
    max: usize,
) -> Result<String, String> {
    let value = raw.get("correct_answer").ok_or("缺少 correct_answer")?;
    let letters: Vec<String> = match value {
        Value::String(text) => text
            .chars()
            .filter(char::is_ascii_uppercase)
            .map(String::from)
            .collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .filter_map(|text| text.chars().find(char::is_ascii_uppercase))
            .map(String::from)
            .collect(),
        _ => return Err("correct_answer 类型无效".to_string()),
    };
    if letters.len() < min || letters.len() > max {
        return Err(format!("正确答案数量不符（要求 {min}-{max}）"));
    }
    let valid: Vec<String> = (0..options.len())
        .map(|index| char::from(b'A' + index as u8))
        .map(String::from)
        .collect();
    for letter in &letters {
        if !valid.contains(letter) {
            return Err(format!("correct_answer 越界：{letter}"));
        }
    }
    if letters.len() == 1 {
        Ok(letters[0].clone())
    } else {
        Ok(Value::Array(
            letters.into_iter().map(Value::String).collect(),
        ))
        .map(|value| match value {
            Value::Array(items) => items
                .iter()
                .filter_map(|v| v.as_str())
                .map(String::from)
                .collect::<Vec<_>>()
                .join(","),
            other => other.to_string(),
        })
    }
}

fn string_list(raw: &Value, name: &str) -> Vec<String> {
    raw.get(name)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_rubric(raw: &Value) -> Result<Vec<RubricItem>, String> {
    let items = raw
        .get("scoring_rubric")
        .and_then(|r| r.as_array())
        .ok_or("essay 缺少 scoring_rubric")?;
    let rubric: Vec<RubricItem> = items
        .iter()
        .filter_map(|item| {
            Some(RubricItem {
                description: item.get("description")?.as_str()?.to_string(),
                max_points: item.get("max_points")?.as_f64()?,
            })
        })
        .collect();
    if rubric.is_empty() {
        return Err("scoring_rubric 为空".to_string());
    }
    Ok(rubric)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(content: &str) -> KnowledgeChunk {
        KnowledgeChunk {
            title: "视频A".into(),
            content: content.into(),
        }
    }

    fn sample_raw(q_type: &str) -> Value {
        json!({
            "type": q_type,
            "question": "RAG 中向量检索的作用是什么？",
            "options": ["A. 语义匹配", "B. 压缩视频", "C. 生成弹幕", "D. 排序评论"],
            "correct_answer": "A",
            "keywords": ["语义", "召回", "排序"],
            "answer_template": "先语义召回再重排……",
            "model_answer": "通过 embedding 做语义召回……",
            "scoring_rubric": [
                {"description": "提到语义召回", "max_points": 4},
                {"description": "提到与重排结合", "max_points": 6}
            ],
            "explanation": "向量检索负责语义召回。",
            "difficulty": "easy"
        })
    }

    #[test]
    fn single_choice_normalizes_options_and_letter() {
        let question = normalize_question(&sample_raw(TYPE_SINGLE), "easy", &[chunk("x")]).unwrap();
        assert_eq!(question.question_type, TYPE_SINGLE);
        assert_eq!(question.options.as_ref().unwrap().len(), 4);
        assert_eq!(question.correct_answer.unwrap(), Value::String("A".into()));
        assert!(!question.low_confidence);
        assert_eq!(question.source_snippet, "x");
    }

    #[test]
    fn multi_choice_requires_two_to_four_letters() {
        let mut raw = sample_raw(TYPE_MULTI);
        raw["correct_answer"] = json!("A");
        assert!(normalize_question(&raw, "easy", &[chunk("x")]).is_err());
        raw["correct_answer"] = json!(["A", "C"]);
        let question = normalize_question(&raw, "easy", &[chunk("x")]).unwrap();
        assert_eq!(
            question.correct_answer.unwrap(),
            Value::String("A,C".into())
        );
    }

    #[test]
    fn short_answer_requires_three_keywords() {
        let mut raw = sample_raw(TYPE_SHORT);
        raw["keywords"] = json!(["只有", "两个"]);
        assert!(normalize_question(&raw, "medium", &[chunk("x")]).is_err());
        raw["keywords"] = json!(["语义", "召回", "排序"]);
        let question = normalize_question(&raw, "medium", &[chunk("x")]).unwrap();
        assert_eq!(question.keywords.len(), 3);
    }

    #[test]
    fn essay_needs_model_answer_and_rubric() {
        let mut raw = sample_raw(TYPE_ESSAY);
        raw["model_answer"] = json!(Value::Null);
        assert!(normalize_question(&raw, "hard", &[chunk("x")]).is_err());
        let question = normalize_question(&sample_raw(TYPE_ESSAY), "hard", &[chunk("x")]).unwrap();
        assert_eq!(question.scoring_rubric.as_ref().unwrap().len(), 2);
        assert_eq!(question.max_points(), 10.0);
    }

    #[test]
    fn unknown_types_rejected_and_option_prefixes_stripped() {
        assert!(normalize_question(&sample_raw("true_false"), "easy", &[chunk("x")]).is_err());
        // "A. 语义匹配" prefix is stripped into the bare option text.
        let question = normalize_question(&sample_raw(TYPE_SINGLE), "easy", &[chunk("x")]).unwrap();
        assert_eq!(question.options.as_ref().unwrap()[0], "语义匹配");
    }

    #[test]
    fn reply_parser_tolerates_code_fences() {
        let fenced =
            "```json\n{\"questions\":[{\"type\":\"single_choice\",\"question\":\"q\"}]}\n```";
        assert_eq!(parse_questions_reply(fenced).unwrap().len(), 1);
        assert!(parse_questions_reply("no json").is_err());
    }
}
