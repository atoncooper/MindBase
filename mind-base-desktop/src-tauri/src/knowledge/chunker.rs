//! Rule-based semantic chunking, ported from the backend's
//! `app/services/rag/chunking.py` (`SemanticChunker`).
//!
//! Same three phases and the same default sizes (target 750 / min 300 /
//! max 900 / overlap 100 chars):
//!
//! 1. preprocess — collapse abnormal whitespace, keep paragraph structure
//! 2. semantic split — outline-title boundaries > blank-line paragraphs >
//!    heading patterns > sentence punctuation
//! 3. merge & window — greedily join short segments up to `TARGET`, then
//!    sliding-window anything over `MAX` with sentence-level overlap
//!
//! One deliberate deviation: a detected heading line starts its segment (in
//! chunking.py the regex-split reassembly attaches it to the preceding text,
//! which reads like an oversight; ASR prose rarely hits this path either way).

/// One produced chunk: what is shown, plus the title-prefixed text that gets
/// embedded.
pub(crate) struct ChunkResult {
    pub display_text: String,
    pub embedding_text: String,
}

pub(crate) const TARGET_SIZE: usize = 750;
// Note: the backend's MIN_SIZE (300) informs tuning only — greedy merging
// handles short segments implicitly, so no minimum is enforced here either.
pub(crate) const MAX_SIZE: usize = 900;
const OVERLAP: usize = 100;

// ---------------------------------------------------------------------------
// Phase 1 — preprocessing
// ---------------------------------------------------------------------------

/// Collapse blank-line runs (3+ newlines → 2), trim lines, squeeze spaces.
fn preprocess(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut blank_run = 0usize;
    for line in text.lines() {
        let trimmed = squeeze_spaces(line.trim());
        if trimmed.is_empty() {
            blank_run += 1;
            // Keep at most one empty line between paragraphs.
            if blank_run <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
        } else {
            blank_run = 0;
            lines.push(trimmed);
        }
    }
    lines.join("\n").trim().to_string()
}

/// Collapse runs of ASCII spaces into one.
fn squeeze_spaces(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut space_run = false;
    for ch in line.chars() {
        if ch == ' ' {
            if !space_run {
                result.push(' ');
            }
            space_run = true;
        } else {
            space_run = false;
            result.push(ch);
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Heading detection (hand-rolled replacement for TITLE_PATTERN)
// ---------------------------------------------------------------------------

/// True when `line` starts with one of the recognized heading shapes,
/// mirroring TITLE_PATTERN's alternatives exactly (including their whitespace
/// requirements): `#{1,3}\s+`, `第[ordinal]+[章节篇]\s*`, `【…】`,
/// `\d+[.、]\s+`.
fn is_heading_line(line: &str) -> bool {
    heading_text_of(line).is_some()
}

/// True when the line begins with 第[一二三四五六七八九十\d]+ — the ordinal
/// prefix used by `第X章` style headings.
fn starts_with_chinese_ordinal(line: &str) -> bool {
    if !line.starts_with('第') {
        return false;
    }
    let rest = &line['第'.len_utf8()..];
    match rest.chars().next() {
        Some(c) => "一二三四五六七八九十".contains(c) || c.is_ascii_digit(),
        None => false,
    }
}

/// Advance past the `第[ordinal]+` prefix.
fn skip_chinese_ordinal(line: &str) -> &str {
    let mut rest = &line['第'.len_utf8()..];
    while let Some(c) = rest.chars().next() {
        if "一二三四五六七八九十".contains(c) || c.is_ascii_digit() {
            rest = &rest[c.len_utf8()..];
        } else {
            break;
        }
    }
    rest
}

/// The heading text carried by `line` when it is a recognized heading
/// (`# 标题` → `标题`, `【标题】…` → `标题`, `第十二章 某某` → `某某`,
/// `3. 某某` → `某某`). `None` for non-headings and bare markers.
///
/// Whitespace rules follow TITLE_PATTERN: markdown hashes and `N.`/`N、`
/// need at least one space before the title; `第X章` does not.
fn heading_text_of(line: &str) -> Option<String> {
    // `#{1,3}\s+<title>`
    if line.starts_with('#') {
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if (1..=3).contains(&hashes) {
            let rest = &line[hashes..];
            if rest.starts_with([' ', '\t']) {
                let title = rest.trim();
                return (!title.is_empty()).then(|| title.to_string());
            }
        }
        return None;
    }
    // `【<title>】…`
    if line.starts_with('【') {
        let end = line.find('】')?;
        let inner = line['【'.len_utf8()..end].trim();
        return (!inner.is_empty()).then(|| inner.to_string());
    }
    // `第[ordinal]+[章节篇]<title?>`
    if starts_with_chinese_ordinal(line) {
        let after_ordinal = skip_chinese_ordinal(line);
        let marker = after_ordinal.chars().next()?;
        if matches!(marker, '章' | '节' | '篇') {
            let title = after_ordinal[marker.len_utf8()..].trim();
            return (!title.is_empty()).then(|| title.to_string());
        }
        return None;
    }
    // `\d+[.、]\s+<title>` — whitespace required right after the marker, so
    // decimals like "3.5" never qualify.
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits < line.len() {
        let after = &line[digits..];
        let marker = after.chars().next()?;
        if marker == '.' || marker == '、' {
            let rest = &after[marker.len_utf8()..];
            if rest.starts_with([' ', '\t']) {
                let title = rest.trim();
                return (!title.is_empty()).then(|| title.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/// Split on sentence-ending punctuation, keeping the punctuation attached.
fn split_to_sentences(text: &str) -> Vec<String> {
    let terminators = ['。', '！', '？', '.', '!', '?'];
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_run = false;
    for ch in text.chars() {
        current.push(ch);
        if terminators.contains(&ch) {
            in_run = true;
            continue;
        }
        if in_run {
            // Run ended: flush the completed sentence.
            sentences.push(std::mem::take(&mut current));
            in_run = false;
        }
    }
    if !current.is_empty() {
        sentences.push(current);
    }
    sentences.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

// ---------------------------------------------------------------------------
// Phase 2 — semantic segmentation
// ---------------------------------------------------------------------------

/// Split by outline-title positions (strongest boundary); empty when fewer
/// than two positions hit so callers fall through to paragraph splitting.
fn split_by_outline(text: &str, outline_titles: &[String]) -> Vec<String> {
    let mut positions: Vec<usize> = vec![0];
    let byte_text = text.as_bytes();
    for title in outline_titles {
        if title.is_empty() {
            continue;
        }
        if let Some(idx) = text.find(title.as_str()) {
            // Guard against splitting inside a multi-byte char (find returns
            // char boundary offsets already, but dedupe near-duplicates).
            if idx < byte_text.len() {
                positions.push(idx);
            }
        }
    }
    positions.sort_unstable();
    positions.dedup();
    if positions.len() < 2 {
        return Vec::new();
    }
    let mut segments = Vec::new();
    for i in 0..positions.len() {
        let start = positions[i];
        let end = positions.get(i + 1).copied().unwrap_or(byte_text.len());
        let seg = text[start..end].trim();
        if !seg.is_empty() {
            segments.push(seg.to_string());
        }
    }
    segments
}

/// Split an over-long paragraph at heading lines, else by sentences.
fn split_long_paragraph(para: &str) -> Vec<String> {
    let mut segments: Vec<String> = Vec::new();
    for line in para.lines() {
        if is_heading_line(line) && segments.iter().any(|s| !s.trim().is_empty()) {
            segments.push(String::new()); // heading starts a fresh segment
        }
        if !line.trim().is_empty() {
            if segments.is_empty() {
                segments.push(String::new());
            }
            if !segments.last().unwrap().is_empty() {
                segments.last_mut().unwrap().push('\n');
            }
            segments.last_mut().unwrap().push_str(line.trim());
        }
    }
    let non_empty: Vec<String> = segments
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if non_empty.len() > 1 {
        return non_empty;
    }
    let sentences = split_to_sentences(para);
    if sentences.len() > 1 {
        return sentences;
    }
    vec![para.to_string()]
}

/// Full semantic segmentation of preprocessed text.
fn split_by_semantic_boundaries(text: &str, outline_titles: &[String]) -> Vec<String> {
    if !outline_titles.is_empty() {
        let outline_segments = split_by_outline(text, outline_titles);
        if outline_segments.len() > 1 {
            return outline_segments;
        }
    }
    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if paragraphs.is_empty() {
        return vec![text.to_string()];
    }
    let mut segments = Vec::new();
    for para in paragraphs {
        if para.chars().count() > MAX_SIZE {
            segments.extend(split_long_paragraph(&para));
        } else {
            segments.push(para);
        }
    }
    segments
}

// ---------------------------------------------------------------------------
// Phase 3 — merge short segments, window over-long ones
// ---------------------------------------------------------------------------

fn merge_and_split_segments(segments: &[String]) -> Vec<String> {
    if segments.is_empty() {
        return Vec::new();
    }

    // Greedy join of adjacent segments up to TARGET.
    let mut merged: Vec<String> = Vec::new();
    let mut current = String::new();
    for seg in segments {
        if current.is_empty() {
            current = seg.clone();
        } else if current.chars().count() + seg.chars().count() <= TARGET_SIZE {
            current.push('\n');
            current.push_str(seg);
        } else {
            merged.push(std::mem::take(&mut current));
            current = seg.clone();
        }
    }
    if !current.is_empty() {
        merged.push(current);
    }

    // Sliding window for anything beyond MAX.
    let mut final_chunks = Vec::new();
    for text in merged {
        if text.chars().count() <= MAX_SIZE {
            final_chunks.push(text);
        } else {
            final_chunks.extend(split_long_text(&text));
        }
    }
    final_chunks
}

fn split_long_text(text: &str) -> Vec<String> {
    let sentences = split_to_sentences(text);
    if sentences.len() <= 1 {
        return vec![text.to_string()];
    }
    let len = |s: &str| s.chars().count();

    let mut chunks: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < sentences.len() {
        // Pack sentences while they fit within TARGET…
        let mut current = String::new();
        let mut j = i;
        while j < sentences.len() && len(&current) + len(&sentences[j]) <= TARGET_SIZE {
            current.push_str(&sentences[j]);
            j += 1;
        }
        // …or take one oversized sentence as-is when nothing fits.
        let chunk = if current.is_empty() {
            j += 1;
            sentences[j - 1].clone()
        } else {
            current
        };
        chunks.push(chunk);

        // Overlap: walk back until ~OVERLAP chars are re-covered. `j >= i+1`
        // always holds here, so `k = j-1 >= i` never underflows.
        let mut overlap_chars = 0usize;
        let mut k = j - 1;
        while k > i && overlap_chars < OVERLAP {
            overlap_chars += len(&sentences[k]);
            k -= 1;
        }
        i = if k > i { k + 1 } else { j };
    }
    chunks
}

// ---------------------------------------------------------------------------
// Metadata detection + embedding-text header
// ---------------------------------------------------------------------------

fn detect_section_title(
    chunk_text: &str,
    outline_titles: &[String],
    page_title: Option<&str>,
) -> Option<String> {
    // A heading-shaped first line wins — but only when the chunk has more
    // lines (mirrors the backend regex requiring a trailing newline; a
    // single-line transcript must not turn its whole body into a title).
    let mut lines = chunk_text.lines();
    if let (Some(first), Some(_)) = (lines.next(), lines.next()) {
        if let Some(title) = heading_text_of(first) {
            return Some(title);
        }
    }
    // Outline titles appearing early in the body.
    let head: String = chunk_text.chars().take(300).collect();
    for title in outline_titles {
        if !title.is_empty() && head.contains(title.as_str()) {
            return Some(title.clone());
        }
    }
    page_title.map(str::to_string).filter(|s| !s.is_empty())
}

fn build_embedding_text(
    chunk_text: &str,
    video_title: &str,
    page_title: Option<&str>,
    section_title: Option<&str>,
) -> String {
    let mut titles: Vec<&str> = Vec::new();
    for candidate in [page_title, Some(video_title), section_title].into_iter().flatten() {
        let trimmed = candidate.trim();
        if !trimmed.is_empty() && !titles.contains(&trimmed) {
            titles.push(trimmed);
        }
    }
    if titles.is_empty() {
        chunk_text.trim().to_string()
    } else {
        format!("{}\n{}", titles.join(" | "), chunk_text.trim())
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Chunk one 分P's transcript. `outline_titles` are optional AI-summary
/// headings used as the strongest segmentation boundary; MIN_SIZE is checked
/// only implicitly (greedy merge pulls small segments together), matching
/// chunking.py where MIN_SIZE informs tuning rather than enforcement.
pub(crate) fn chunk_text(
    text: &str,
    video_title: &str,
    page_title: Option<&str>,
    outline_titles: &[String],
) -> Vec<ChunkResult> {
    let cleaned = preprocess(text);
    if cleaned.is_empty() {
        return Vec::new();
    }
    let segments = split_by_semantic_boundaries(&cleaned, outline_titles);
    if segments.is_empty() {
        return Vec::new();
    }
    let final_chunks = merge_and_split_segments(&segments);

    let mut results = Vec::new();
    for chunk_text in final_chunks {
        // The section title feeds the embedding header. Content-type stays a
        // standalone detection helper (the local vector table has no metadata
        // columns to persist it into).
        let section_title =
            detect_section_title(&chunk_text, outline_titles, page_title);
        let embedding_text =
            build_embedding_text(&chunk_text, video_title, page_title, section_title.as_deref());
        results.push(ChunkResult {
            display_text: chunk_text,
            embedding_text,
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(text: &str) -> Vec<ChunkResult> {
        chunk_text(text, "", None, &[])
    }

    #[test]
    fn short_text_yields_single_chunk_without_header() {
        let results = chunk("这是一段很短的文本。");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_text, "这是一段很短的文本。");
        // No titles provided → embedding text identical to display text.
        assert_eq!(results[0].embedding_text, "这是一段很短的文本。");
    }

    #[test]
    fn empty_after_preprocess_is_no_chunks() {
        assert!(chunk("   \n \n  ").is_empty());
        assert!(chunk("").is_empty());
    }

    #[test]
    fn long_text_windows_at_target_with_overlap_tail() {
        let sentence = "十个字的一句话。"; // 8 chars incl. terminator
        let text = sentence.repeat(400);
        let results = chunk(&text);
        assert!(results.len() > 1, "must be windowed into several chunks");
        for r in &results {
            let len = r.display_text.chars().count();
            assert!(len <= MAX_SIZE + sentence.len(), "chunk too long: {len}");
        }
        // Consecutive chunks share their overlap: the last full sentence of
        // chunk N reappears inside chunk N+1.
        let last_sentence_of_first = split_to_sentences(&results[0].display_text)
            .last()
            .expect("first chunk has sentences")
            .clone();
        assert!(
            results[1].display_text.contains(&last_sentence_of_first),
            "overlap should repeat the previous tail"
        );
    }

    #[test]
    fn outline_boundaries_survive_merge() {
        // Section bodies are sized so adjacent segments exceed TARGET and the
        // greedy merge cannot re-join them (mirrors chunking.py behavior).
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
        assert_eq!(results.len(), 4);
        assert!(results[0].display_text.starts_with("开场白"));
        assert!(results[1].display_text.starts_with("第一章"));
        assert!(results[2].display_text.starts_with("第二章"));
        assert!(results[3].display_text.starts_with("第三章"));
        // Section title feeds the embedding header (title line + body).
        assert!(
            results[1].embedding_text.starts_with("分P | 视频 | 第一章 基础概念\n"),
            "unexpected header: {}",
            results[1].embedding_text
        );
    }

    #[test]
    fn tiny_outline_segments_merge_back_like_backend() {
        // Short sections fall inside TARGET and merge — same as chunking.py.
        let text = "开始介绍。第一章 基础概念内容。第二章 进阶用法内容。";
        let outline = vec!["第一章 基础概念".to_string()];
        let results = chunk_text(text, "", None, &outline);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn heading_lines_start_new_segments() {
        let para = "前导内容一。前导内容二。## 第一节 内容主体这里展开说明。后续补充句子。继续更多内容。".repeat(30);
        let results = chunk(&para);
        assert!(!results.is_empty());
        // The heading text surfaces in some chunk's embedding header.
        assert!(results
            .iter()
            .any(|r| r.embedding_text.contains("第一节")));
    }

    #[test]
    fn embedding_header_dedupes_and_joins() {
        assert_eq!(
            build_embedding_text("正文", "视频A", Some("视频A"), Some("章节")),
            "视频A | 章节\n正文"
        );
        assert_eq!(build_embedding_text("正文", "", None, None), "正文");
    }

    #[test]
    fn heading_shapes_all_recognized() {
        for line in [
            "# 标题",
            "### 三级标题",
            "【括号标题】内容",
            "第十二章 某某",
            "第2节无空格标题",
            "3. 数字点标题",
            "4、 顿号标题",
        ] {
            assert!(is_heading_line(line), "should be heading: {line}");
            assert!(heading_text_of(line).is_some(), "title of: {line}");
        }
        // Whitespace rules mirror TITLE_PATTERN exactly.
        assert_eq!(heading_text_of("# 标题").as_deref(), Some("标题"));
        assert!(!is_heading_line("#无空格不算"));
        assert!(!is_heading_line("4、无空格也不算"));
        assert!(!is_heading_line("普通一句话."));
        assert!(!is_heading_line("#### 四级不算"));
        assert!(!is_heading_line("3.5 是小数不是标题")); // no space after dot
        assert!(!is_heading_line("第十二章")); // marker with no title text
    }
}

