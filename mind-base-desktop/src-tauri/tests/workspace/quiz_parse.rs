//! workspace::quiz::parse：模型回复 JSON 解析。

use mind_base_desktop_lib::testing::parse_quiz_questions;
use serde_json::json;

#[test]
fn json_reply_with_questions_is_parsed() {
    let reply = json!({
        "questions": [
            {"type": "single_choice", "question": "RAG 中向量检索的作用？", "options": ["A. 语义匹配", "B. 压缩视频"], "correct_answer": "A"}
        ]
    })
    .to_string();
    let questions = parse_quiz_questions(&reply).expect("should parse");
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0]["question"], "RAG 中向量检索的作用？");
}

#[test]
fn fenced_json_reply_is_tolerated() {
    let reply = "\u{60}\u{60}\u{60}json\n{\"questions\": []}\n\u{60}\u{60}\u{60}";
    let questions = parse_quiz_questions(reply).expect("fenced json should parse");
    assert!(questions.is_empty());
}

#[test]
fn invalid_reply_is_rejected() {
    assert!(parse_quiz_questions("这不是 JSON").is_err());
    assert!(parse_quiz_questions("").is_err());
}
