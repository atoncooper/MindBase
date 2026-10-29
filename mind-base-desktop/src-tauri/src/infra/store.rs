//! Unified append-only store — JSONL index + Markdown parts (plan/
//! 1.0.10-AgentMemory §4). One engine, three streams:
//!
//! - conversation transcript: `<data>/conversations/<sid>/` (turn records)
//! - error stream:            same dir (`errors.jsonl` + `error-*.md`)
//! - agent private memory:    `<data>/agents/<name>/memory/` (episodic events
//!   + curated knowledge)
//!
//! Iron laws (§2 of the plan): content parts are append-only (line numbers
//! never shift — the span pointers depend on it); the index is written AFTER
//! its content (the index never claims lines that do not exist); parts split
//! only on record boundaries; everything is UTF-8 with LF endings.
//!
//! Heavy content lives in the parts; the JSONL lines carry summaries +
//! span pointers, so a reader can skim the index and pull full text only
//! for the records it actually needs.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Split a part file once it grows past this many lines (record boundaries
/// only — a record is never split across parts).
const PART_MAX_LINES: usize = 1500;

/// One content span: file name inside the store dir + inclusive 1-based
/// line range. The pointer format the whole design rests on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Span {
    pub file: String,
    pub start: usize,
    pub end: usize,
}

impl Span {
    fn to_json(&self) -> Value {
        json!({"file": self.file, "start": self.start, "end": self.end})
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("cannot create {}: {err}", dir.display()))
}

/// Append raw text to the store, returning the 1-based inclusive line span
/// of what was written. Normalizes CRLF to LF (line pointers are only
/// stable under one line-ending convention). Text is preceded by a blank
/// line when the file does not end empty.
fn append_text(path: &Path, text: &str) -> Result<Span, String> {
    let normalized = text.replace("\r\n", "\n");
    let existing = if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|err| format!("cannot read {}: {err}", path.display()))?
    } else {
        String::new()
    };
    let mut current = existing;
    let start = if current.is_empty() {
        1
    } else {
        current.lines().count() + 1
    };
    if !current.is_empty() && !current.ends_with('\n') {
        current.push('\n');
    }
    current.push_str(&normalized);
    if !current.ends_with('\n') {
        current.push('\n');
    }
    let end = current.lines().count();
    std::fs::write(path, &current)
        .map_err(|err| format!("cannot write {}: {err}", path.display()))?;
    Ok(Span {
        file: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
        start,
        end,
    })
}

/// Find the newest part file with the given prefix (`part-` / `error-`),
/// starting a new one when the newest is missing or over the split budget.
/// Parts live flat in the store dir; `prefix` keeps the two streams apart.
fn current_part(dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    ensure_dir(dir)?;
    let mut best: Option<(u32, PathBuf)> = None;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(dir.join(format!("{prefix}-0001--{}.md", now_secs())));
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // part-0001--<ts>.md
        let rest = name.strip_prefix(prefix).and_then(|r| r.strip_prefix('-'));
        if let Some(rest) = rest {
            if let Some(seq) = rest.split("--").next().and_then(|s| s.parse::<u32>().ok()) {
                if best.as_ref().map(|(b, _)| seq > *b).unwrap_or(true) {
                    best = Some((seq, entry.path()));
                }
            }
        }
    }
    match best {
        Some((seq, path)) => {
            let lines = std::fs::read_to_string(&path)
                .map(|content| content.lines().count())
                .unwrap_or(0);
            if lines >= PART_MAX_LINES {
                Ok(dir.join(format!("{prefix}-{}--{}.md", seq + 1, now_secs())))
            } else {
                Ok(path)
            }
        }
        None => Ok(dir.join(format!("{prefix}-0001--{}.md", now_secs()))),
    }
}

pub(crate) fn append_json_line(index_path: &Path, value: &Value) -> Result<(), String> {
    ensure_dir(
        index_path
            .parent()
            .ok_or_else(|| "index path has no parent".to_string())?,
    )?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(index_path)
        .map_err(|err| format!("cannot open {}: {err}", index_path.display()))?;
    writeln!(file, "{value}").map_err(|err| format!("cannot append index: {err}"))
}

/// Extract the 【摘要】 block (up to 【详细】 / end) as the index summary;
/// falls back to the first sentence clamped to 80 chars, flagged automatic.
fn extract_summary(answer: &str) -> (String, bool) {
    let trimmed = answer.trim_start();
    if let Some(rest) = trimmed.strip_prefix("【摘要】") {
        let summary: String = rest
            .split("【详细】")
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect();
        if !summary.is_empty() {
            return (summary, false);
        }
    }
    let auto: String = trimmed.chars().take(80).collect();
    (auto, true)
}

/// Append one Q/A turn to the conversation store:
/// user + assistant blocks into a part file, one index line with summaries
/// and span pointers. Returns the turn id.
pub(crate) fn append_turn(
    root: &Path,
    agent: &str,
    kind: &str,
    question: &str,
    answer: &str,
    extra: Value,
) -> Result<String, String> {
    let ts = now_secs();
    let part = current_part(root, "part")?;
    let seq = index_len(root)?;
    let turn_id = format!("t-{seq:06}");

    let user_anchor = format!("<!-- {turn_id} role:user ts:{ts} -->\n## 用户\n");
    let user_span = append_text(&part, &format!("{user_anchor}{question}\n"))?;
    let resp_anchor = format!("<!-- {turn_id} role:assistant ts:{ts} -->\n## 助手\n");
    let resp_span = append_text(&part, &format!("{resp_anchor}{answer}\n"))?;

    let (summary, summary_auto) = extract_summary(answer);
    let q_preview: String = question.trim().chars().take(80).collect();
    let mut record = json!({
        "turn_id": turn_id,
        "seq": seq,
        "ts": ts,
        "agent": agent,
        "kind": kind,
        "status": "completed",
        "q_preview": q_preview,
        "summary": summary,
        "summary_auto": summary_auto,
        "user": user_span.to_json(),
        "resp": resp_span.to_json(),
    });
    if let (Some(obj), Some(extra)) = (record.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            obj.insert(key.clone(), value.clone());
        }
    }
    append_json_line(&root.join("index.jsonl"), &record)?;
    Ok(turn_id)
}

/// Append one operational event to events.jsonl (successes and failures
/// alike — the traceability backbone keyed by run_id).
pub(crate) fn append_event(root: &Path, mut event: Value) -> Result<(), String> {
    if let Some(obj) = event.as_object_mut() {
        obj.entry("ts").or_insert(json!(now_secs()));
    }
    append_json_line(&root.join("events.jsonl"), &event)
}

/// Append a titled section (header + body) to an existing file, returning
/// the span covering both. Used by the agent private-memory knowledge files.
pub(crate) fn append_section(path: &Path, header: &str, body: &str) -> Result<Span, String> {
    append_text(path, &format!("{header}\n{body}\n"))
}

/// Append one normalized error: summary line into errors.jsonl, full
/// traceback into its own error part (span pointer). Returns the error id.
pub(crate) fn append_error(
    root: &Path,
    run_id: &str,
    step: u32,
    agent: &str,
    error_kind: &str,
    message: &str,
    detail: &str,
) -> Result<String, String> {
    let ts = now_secs();
    let part = current_part(root, "error")?;
    let seq = errors_len(root)?;
    let err_id = format!("err-{seq:06}");
    let header = format!("<!-- {err_id} run:{run_id} step:{step} kind:{error_kind} ts:{ts} -->\n");
    let span = append_text(&part, &format!("{header}{message}\n\n{detail}\n"))?;
    let summary: String = message.trim().chars().take(200).collect();
    append_json_line(
        &root.join("errors.jsonl"),
        &json!({
            "err_id": err_id,
            "run_id": run_id,
            "step": step,
            "agent": agent,
            "error_kind": error_kind,
            "digest": error_digest(&summary, error_kind),
            "summary": summary,
            "detail": span.to_json(),
            "status": "open",
            "fixes": [],
            "ts": ts,
        }),
    )?;
    Ok(err_id)
}

/// Error fingerprint = kind + first digestable line (md5) — drives the
/// repeated-failure escalation gate.
fn error_digest(summary: &str, kind: &str) -> String {
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(kind.as_bytes());
    hasher.update(b"|");
    hasher.update(summary.as_bytes());
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{kind}:{}", &hex[..12])
}

fn index_len(root: &Path) -> Result<u64, String> {
    count_lines(&root.join("index.jsonl"))
}

fn errors_len(root: &Path) -> Result<u64, String> {
    count_lines(&root.join("errors.jsonl"))
}

fn count_lines(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let content = std::fs::read_to_string(path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    Ok(content.lines().count() as u64)
}

/// Parse every index line (torn trailing lines from a crash are skipped).
pub(crate) fn list_records(index_path: &Path) -> Result<Vec<Value>, String> {
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(index_path)
        .map_err(|err| format!("cannot read {}: {err}", index_path.display()))?;
    Ok(content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

/// Read the inclusive line span of a part file (1-based, index-verified).
pub(crate) fn read_span(root: &Path, span: &Span) -> Result<String, String> {
    let path = root.join(&span.file);
    let content = std::fs::read_to_string(&path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    let selected: String = content
        .lines()
        .skip(span.start.saturating_sub(1))
        .take(span.end.saturating_sub(span.start.saturating_sub(1)) + 1)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(selected)
}

/// Substring grep over every `*.md` part in the store, returning
/// `(file, line_no, line)` — the entry point that resolves back through the
/// index for full context.
pub(crate) fn grep_parts(root: &Path, query: &str) -> Result<Vec<(String, usize, String)>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    collect_md_grep(root, query, &mut hits)?;
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(hits)
}

fn collect_md_grep(
    dir: &Path,
    query: &str,
    out: &mut Vec<(String, usize, String)>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_md_grep(&path, query, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            for (offset, line) in content.lines().enumerate() {
                if line.contains(query) {
                    out.push((file.clone(), offset + 1, line.to_string()));
                    if out.len() >= 50 {
                        return Ok(());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mb-store-test-{}-{}", std::process::id(), tag));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn append_turn_writes_spans_and_index_summary() {
        let temp = TempDir::new("turn");
        let root = temp.0.join("conversations").join("s1");
        let answer = "【摘要】清空 target 即可。\n【详细】\n第一步……\n第二步……";
        let turn_id = append_turn(&root, "chat", "question", "怎么清理？", answer, json!({}))
            .expect("append turn");
        assert_eq!(turn_id, "t-000000");

        let records = list_records(&root.join("index.jsonl")).expect("index");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["summary"], "清空 target 即可。");
        assert_eq!(records[0]["summary_auto"], false);

        let user: Span = serde_json::from_value(records[0]["user"].clone()).expect("user span");
        let resp: Span = serde_json::from_value(records[0]["resp"].clone()).expect("resp span");
        assert!(read_span(&root, &user)
            .expect("user text")
            .contains("怎么清理？"));
        assert!(read_span(&root, &resp)
            .expect("resp text")
            .contains("第二步"));
        assert!(
            !read_span(&root, &resp)
                .expect("resp text")
                .contains("怎么清理？"),
            "user text must not leak into resp span"
        );
    }

    #[test]
    fn summary_falls_back_to_first_80_chars_when_marker_missing() {
        let temp = TempDir::new("fallback");
        let root = temp.0.join("s");
        let answer = "没有标记的回答。".repeat(20);
        append_turn(&root, "chat", "question", "q", &answer, json!({})).expect("append");
        let records = list_records(&root.join("index.jsonl")).expect("index");
        assert_eq!(records[0]["summary_auto"], true);
        let summary = records[0]["summary"].as_str().expect("summary");
        assert!(summary.chars().count() <= 80);
    }

    #[test]
    fn parts_split_on_record_boundary_and_line_numbers_stay_stable() {
        let temp = TempDir::new("split");
        let root = temp.0.join("s");
        // Two big turns: the second must land in a fresh part once the
        // budget is crossed, and earlier spans must keep resolving.
        let big_answer = "行\n".repeat(PART_MAX_LINES);
        for i in 0..2 {
            append_turn(
                &root,
                "chat",
                "question",
                &format!("q{i}"),
                &format!("a{i} {big_answer}"),
                json!({}),
            )
            .expect("append");
        }
        let records = list_records(&root.join("index.jsonl")).expect("index");
        assert_eq!(records.len(), 2);
        let first: Span = serde_json::from_value(records[0]["resp"].clone()).expect("span");
        let second: Span = serde_json::from_value(records[1]["resp"].clone()).expect("span");
        assert_ne!(first.file, second.file, "budget crossed → new part");
        assert!(read_span(&root, &first).expect("first").contains("a0"));
        assert!(read_span(&root, &second).expect("second").contains("a1"));
    }

    #[test]
    fn errors_get_id_digest_and_resolvable_detail() {
        let temp = TempDir::new("errors");
        let root = temp.0.join("s");
        let err_id = append_error(
            &root,
            "r-1",
            4,
            "code",
            "compile",
            "E0308 mismatched types",
            "full traceback line 1\nline 2\nline 3",
        )
        .expect("append error");
        assert_eq!(err_id, "err-000000");

        let records = list_records(&root.join("errors.jsonl")).expect("errors");
        assert_eq!(records.len(), 1);
        assert!(records[0]["digest"]
            .as_str()
            .expect("digest")
            .starts_with("compile:"));
        let detail: Span = serde_json::from_value(records[0]["detail"].clone()).expect("span");
        let text = read_span(&root, &detail).expect("detail");
        assert!(text.contains("line 2"));
    }

    #[test]
    fn grep_parts_finds_lines_across_files() {
        let temp = TempDir::new("grep");
        let root = temp.0.join("s");
        append_turn(
            &root,
            "chat",
            "question",
            "怎么清理 target？",
            "用 cargo clean",
            json!({}),
        )
        .expect("turn");
        append_error(&root, "r", 1, "code", "runtime", "panic at cleanup", "boom").expect("error");
        let hits = grep_parts(&root, "cargo").expect("grep");
        assert!(hits.iter().any(|(_, _, line)| line.contains("cargo clean")));
        assert!(grep_parts(&root, "  ").expect("blank query").is_empty());
    }
}
