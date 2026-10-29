//! Retrieval context rendering + source/title helpers (pure).

use super::types::ChatSource;
use crate::knowledge::ingest::KnowledgeHit;

/// Sources persisted/emitted per assistant message (backend caps at 5).
const SOURCE_CAP: usize = 5;
/// Max chunks shown per video inside the context blocks (mirror `_format_docs`).
const PER_VIDEO_CHUNKS: usize = 6;
/// Titles treated as "not yet named" — user renames always win over these.
pub(super) const DEFAULT_TITLES: [&str; 4] = ["", "新对话", "未命名对话", "Untitled"];
/// Max characters for any generated title.
pub(super) const TITLE_MAX_CHARS: usize = 18;

// ---------------------------------------------------------------------------
// Prompt / formatting (pure)
// ---------------------------------------------------------------------------

/// True when a hit's chunk belongs to the grouping key of another video.
/// Group key is the bvid; hits without one group under their doc id.
fn group_key(hit: &KnowledgeHit) -> String {
    if hit.bvid.is_empty() {
        hit.doc_id.clone()
    } else {
        hit.bvid.clone()
    }
}

/// Display heading of one video group inside the context block.
fn group_heading(hits: &[KnowledgeHit]) -> String {
    let first = &hits[0];
    if first.page_title.is_empty() {
        first.video_title.clone()
    } else {
        format!("{} · {}", first.video_title, first.page_title)
    }
}

/// Format retrieval hits into numbered-per-video context blocks, mirroring
/// `_format_docs`: grouped per video (≤ [`PER_VIDEO_CHUNKS`] each), sorted by
/// score within the group, joined by `---`.
pub(crate) fn format_context_blocks(hits: &[KnowledgeHit]) -> String {
    if hits.is_empty() {
        return "（知识库中没有找到相关内容）".to_string();
    }
    let mut groups: Vec<(String, Vec<KnowledgeHit>)> = Vec::new();
    for hit in hits {
        let key = group_key(hit);
        if let Some(group) = groups.iter_mut().find(|(existing, _)| *existing == key) {
            group.1.push(hit.clone());
        } else {
            groups.push((key, vec![hit.clone()]));
        }
    }

    let mut blocks: Vec<String> = Vec::new();
    for (_, group) in groups.iter_mut() {
        group.sort_by(|a, b| b.score.total_cmp(&a.score));
        let heading = group_heading(group);
        let body = group
            .iter()
            .take(PER_VIDEO_CHUNKS)
            .map(|hit| {
                format!(
                    "【{heading}】(相关度: {:.2})\n{}",
                    hit.score,
                    hit.content.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(body);
    }
    blocks.join("\n\n---\n\n")
}

/// Strip decoration from a raw LLM-generated title and clamp its length.
pub(crate) fn sanitize_title(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    for prefix in ["标题：", "标题:", "title:", "Title:", "《", "\"", "'"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_string();
        }
    }
    let trimmed: String = text
        .trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '《' | '》' | '「' | '」' | '『' | '』' | '。' | '！' | '？' | ' '
            )
        })
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(TITLE_MAX_CHARS)
        .collect();
    trimmed
}

/// Fallback title: first non-space chars of the first message.
pub(crate) fn fallback_title(first_message: &str) -> String {
    let squeezed: String = first_message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("");
    let title: String = squeezed.chars().take(TITLE_MAX_CHARS).collect();
    if title.is_empty() {
        "新对话".to_string()
    } else {
        title
    }
}

pub(super) fn is_default_title(title: &str) -> bool {
    DEFAULT_TITLES.contains(&title.trim())
}

/// Dedupe hits by bvid (keep highest score) and cap the list — mirrors the
/// backend `_extract_sources` behavior at the message level.
pub(crate) fn collect_sources(hits: &[KnowledgeHit]) -> Vec<ChatSource> {
    let mut best: Vec<(String, ChatSource)> = Vec::new();
    for hit in hits {
        if hit.url.is_empty() {
            continue;
        }
        let key = if hit.bvid.is_empty() {
            hit.doc_id.clone()
        } else {
            hit.bvid.clone()
        };
        let source = ChatSource {
            title: hit.video_title.clone(),
            page_title: hit.page_title.clone(),
            score: hit.score,
            bvid: hit.bvid.clone(),
            url: hit.url.clone(),
            page_index: hit.page_index,
        };
        match best.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, existing)) => {
                if hit.score > existing.score {
                    *existing = source;
                }
            }
            None => best.push((key, source)),
        }
    }
    best.into_iter()
        .map(|(_, source)| source)
        .take(SOURCE_CAP)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(
        doc_id: &str,
        bvid: &str,
        title: &str,
        page: &str,
        score: f32,
        content: &str,
    ) -> KnowledgeHit {
        KnowledgeHit {
            doc_id: doc_id.to_string(),
            chunk_index: 0,
            content: content.to_string(),
            score,
            bvid: bvid.to_string(),
            page_index: 1,
            video_title: title.to_string(),
            page_title: page.to_string(),
            url: format!("https://www.bilibili.com/video/{bvid}?p=1"),
        }
    }

    #[test]
    fn context_blocks_group_by_video_and_cap_chunks() {
        let hits = vec![
            hit("d1", "BV1", "视频A", "P1", 0.9, "A高"),
            hit("d2", "BV2", "视频B", "", 0.8, "B块"),
            hit("d3", "BV1", "视频A", "P1", 0.7, "A低"),
        ];
        let blocks = format_context_blocks(&hits);
        assert!(blocks.contains("【视频A · P1】"));
        assert!(blocks.contains("【视频B】"));
        assert!(blocks.contains("---"));
        assert!(
            blocks.starts_with("【视频A · P1】"),
            "highest-score group first content"
        );
        assert!(
            blocks.find("A低").unwrap() > blocks.find("A高").unwrap(),
            "sorted by score in group"
        );
    }

    #[test]
    fn empty_context_has_explicit_copy() {
        assert_eq!(format_context_blocks(&[]), "（知识库中没有找到相关内容）");
    }

    #[test]
    fn title_sanitizer_strips_decoration_and_clamps() {
        assert_eq!(sanitize_title("标题：《RAG 系统设计》！"), "RAG系统设计");
        assert_eq!(sanitize_title("\"hello world\""), "helloworld");
        let long = sanitize_title(&"很".repeat(30));
        assert_eq!(long.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(sanitize_title("   "), "");
    }

    #[test]
    fn fallback_title_squeezes_and_truncates() {
        assert_eq!(fallback_title("你好 世界"), "你好世界");
        assert_eq!(fallback_title(""), "新对话");
        assert_eq!(
            fallback_title(&"字 ".repeat(20)).chars().count(),
            TITLE_MAX_CHARS
        );
    }

    #[test]
    fn default_titles_match_backend_set() {
        assert!(is_default_title("新对话"));
        assert!(is_default_title(""));
        assert!(!is_default_title("我的研究计划"));
    }

    #[test]
    fn sources_dedupe_by_bvid_keeping_best_score() {
        let hits = vec![
            hit("d1", "BV1", "视频A", "P1", 0.5, "a"),
            hit("d2", "BV1", "视频A", "P2", 0.9, "b"),
            hit("d3", "BV2", "视频B", "", 0.8, "c"),
        ];
        let sources = collect_sources(&hits);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].score, 0.9, "best score kept for BV1");
        assert_eq!(sources[0].page_title, "P2", "the best-scoring hit survives");
        // Hits without a URL are dropped entirely.
        let mut no_url = hit("d4", "", "无链接", "", 1.0, "x");
        no_url.url = String::new();
        assert!(collect_sources(&[no_url]).is_empty());
    }
}
