//! knowledge::chunker：短文本、空文本、大纲边界、标题行。

use mind_base_desktop_lib::testing::{chunk_text, ChunkView};

fn chunk(text: &str) -> Vec<ChunkView> {
    chunk_text(text, "", None, &[])
}

#[test]
fn short_text_is_a_single_chunk_without_header() {
    let results = chunk("这是一段很短的文本。");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].display_text, "这是一段很短的文本。");
    assert_eq!(results[0].embedding_text, "这是一段很短的文本。");
}

#[test]
fn empty_or_whitespace_text_yields_no_chunks() {
    assert!(chunk("").is_empty());
    assert!(chunk("   \n \n  ").is_empty());
}

#[test]
fn outline_boundaries_are_preserved_in_order() {
    let body_a = "甲".repeat(400);
    let body_b = "乙".repeat(400);
    let body_c = "丙".repeat(400);
    let body_d = "丁".repeat(400);
    let text = format!("开场白。{body_a}第一章 基础概念{body_b}第二章 进阶用法{body_c}第三章 总结收尾{body_d}");
    let outline = vec![
        "第一章 基础概念".to_string(),
        "第二章 进阶用法".to_string(),
        "第三章 总结收尾".to_string(),
    ];
    let results = chunk_text(&text, "视频", Some("分P"), &outline);
    assert_eq!(results.len(), 4, "outline should split into four sections");
    assert!(results[0].display_text.starts_with("开场白"));
    assert!(results[1].display_text.starts_with("第一章"));
    assert!(results[2].display_text.starts_with("第二章"));
    assert!(results[3].display_text.starts_with("第三章"));
    assert!(
        results[1].embedding_text.starts_with("分P | 视频 | 第一章 基础概念\n"),
        "embedding header missing: {}",
        results[1].embedding_text
    );
}

#[test]
fn long_text_is_windowed_into_multiple_chunks() {
    let sentence = "十个字的一句话。";
    let text = sentence.repeat(400);
    let results = chunk(&text);
    assert!(results.len() > 1, "must be windowed into several chunks");
    assert!(results.iter().all(|chunk| !chunk.display_text.is_empty()));
}
