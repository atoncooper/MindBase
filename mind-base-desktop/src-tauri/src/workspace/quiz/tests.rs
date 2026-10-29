//! Cross-submodule tests (parsing + grading + persisted-set round-trip).

use super::*;
use serde_json::{json, Value};

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
    fn objective_grading_matches_letters_case_insensitively() {
        let question = normalize_question(&sample_raw(TYPE_SINGLE), "easy", &[chunk("x")]).unwrap();
        let outcome = grade_question(None, &question, "a");
        assert!(outcome.correct);
        assert_eq!(outcome.score, 1.0);
        let wrong = grade_question(None, &question, "c");
        assert!(!wrong.correct);
    }

    #[test]
    fn short_answer_grading_by_keyword_coverage() {
        let mut question =
            normalize_question(&sample_raw(TYPE_SHORT), "medium", &[chunk("x")]).unwrap();
        question.keywords = vec!["语义".into(), "召回".into(), "重排".into()];
        // Two of three covered → passes at the 60% line.
        let outcome = grade_question(None, &question, "先做语义召回，然后重排");
        assert!(outcome.correct);
        // Only one covered → fails.
        let miss = grade_question(None, &question, "只提到了语义");
        assert!(!miss.correct);
        assert!(miss.feedback.contains("未覆盖关键词"));
    }

    /// A persisted set travels DB-ward as JSON and back — the
    /// `skip_serializing_if` attrs on QuizQuestion must not drop anything the
    /// reload needs.
    #[test]
    fn set_round_trips_through_json() {
        let question = normalize_question(&sample_raw(TYPE_SINGLE), "easy", &[chunk("x")]).unwrap();
        let config = QuizGenerateRequest {
            count: 5,
            types: vec![TYPE_SINGLE.into()],
            difficulty: "medium".into(),
            topic: Some("向量检索".into()),
        };
        let mut answers = std::collections::HashMap::new();
        answers.insert(question.question_id.clone(), "A".to_string());
        let set = QuizSet {
            id: "s1".into(),
            created_at: 42,
            difficulty: "medium".into(),
            question_count: 1,
            config: config.clone(),
            questions: vec![question],
            answers: answers.clone(),
            results: vec![QuizRecordItem {
                question_type: TYPE_SINGLE.into(),
                question: "RAG 中向量检索的作用是什么？".into(),
                given: "A".into(),
                correct: true,
                score: 1.0,
                max_score: 1.0,
                feedback: String::new(),
            }],
            graded: true,
            total_score: 1.0,
            total_max: 1.0,
        };

        let json = serde_json::to_string(&set).unwrap();
        let parsed: QuizSet = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.config.count, 5);
        assert_eq!(parsed.config.topic.as_deref(), Some("向量检索"));
        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].question_type, TYPE_SINGLE);
        assert_eq!(
            parsed
                .answers
                .get(&parsed.questions[0].question_id)
                .map(String::as_str),
            Some("A")
        );
        assert!(parsed.graded);
        assert_eq!(parsed.results.len(), 1);
        assert!(parsed.results[0].correct);

        // topic: null (never set) must deserialize back to None via serde(default).
        let config_json = serde_json::to_string(&config).unwrap();
        let without_topic = config_json.replace("\"topic\":\"向量检索\"", "\"topic\":null");
        let parsed_null: QuizSetCreateRequest = serde_json::from_str(&format!(
            "{{\"config\":{without_topic},\"questions\":{}}}",
            serde_json::to_string(&set.questions).unwrap()
        ))
        .unwrap();
        assert!(parsed_null.config.topic.is_none());
        assert_eq!(parsed_null.questions.len(), 1);
    }
