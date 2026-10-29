//! DashScope response parsing: task ids, poll states and transcript text.

use super::types::TaskState;

/// Extract `task_id` from a submission response (top-level or under output).
pub(super) fn parse_submit_task_id(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 提交响应失败：{err}"))?;
    let task_id = value
        .get("task_id")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/output/task_id").and_then(|v| v.as_str()))
        .unwrap_or_default();
    if task_id.is_empty() {
        return Err(format!("ASR 提交失败：未返回 task_id（{body}）"));
    }
    Ok(task_id.to_string())
}

/// Parse one poll response into a [`TaskState`].
pub(super) fn parse_task_state(body: &str) -> Result<TaskState, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 状态响应失败：{err}"))?;
    let output = value.get("output").unwrap_or(&value);
    let status = output
        .get("task_status")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let error_message = output
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            // Per-file error inside results[0] when the task itself finished.
            output
                .pointer("/results/0/error_message")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    output
                        .pointer("/results/0/message")
                        .and_then(|v| v.as_str())
                })
                .map(str::to_string)
        });
    Ok(TaskState::from_status(status, error_message))
}

/// Pull the SUCCEEDED result URL out of a poll response body.
pub(super) fn parse_transcription_url(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 ASR 状态响应失败：{err}"))?;
    value
        .pointer("/output/results/0/transcription_url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "ASR 结果缺少 transcription_url".to_string())
}

/// Join a transcription result JSON into plain text.
///
/// Priority mirrors asr.py: `transcripts[].text`, falling back to per-sentence
/// text, falling back to a top-level `text`. Then — because DashScope
/// sometimes wraps the transcript under an `output` / `output.results[0]`
/// envelope (the same nesting the code already reads for `transcription_url`)
/// — the extraction is re-run on that inner object before giving up, so real
/// recognized text is never lost to a strict top-level scan.
pub(super) fn parse_transcription_text(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析转写结果失败：{err}"))?;

    let joined = extract_transcript_text(&value);
    if joined.is_empty() {
        return Err("转写结果为空".to_string());
    }
    Ok(joined)
}

/// Priority-based transcript extraction from one JSON node, with an envelope
/// fallback for wrapped DashScope responses.
fn extract_transcript_text(value: &serde_json::Value) -> String {
    let mut texts: Vec<String> = Vec::new();

    let transcripts = value
        .get("transcripts")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    if !transcripts.is_empty() {
        for item in &transcripts {
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                texts.push(text);
                continue;
            }
            if let Some(sentences) = item.get("sentences").and_then(|s| s.as_array()) {
                for sentence in sentences {
                    let sentence_text = sentence
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if !sentence_text.is_empty() {
                        texts.push(sentence_text);
                    }
                }
            }
        }
    }
    if texts.is_empty() {
        if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                texts.push(text.to_string());
            }
        }
    }

    // Envelope fallback: some DashScope responses nest the transcript under
    // `output` or `output.results[0]`. Re-run the same priority extraction on
    // the inner object rather than declaring the result empty.
    if texts.is_empty() {
        if let Some(output) = value.get("output") {
            let nested = extract_transcript_text(output);
            if !nested.is_empty() {
                return nested;
            }
        }
        if let Some(result) = value
            .pointer("/output/results/0")
            .or_else(|| value.get("results"))
        {
            let nested = extract_transcript_text(result);
            if !nested.is_empty() {
                return nested;
            }
        }
    }

    texts.join("\n")
}

/// Best-effort extraction of transcript text from a result frame, tolerant of
/// the many field shapes different real-time ASR models use. It walks the
/// frame and collects non-empty strings found under transcript-like keys
/// (`text`, `transcript`, `sentence`, …) and under structural containers
/// (`payload`, `result`, `sentence`, `transcripts`, `output`).
pub(super) fn collect_transcript(value: &serde_json::Value, texts: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            let s = s.trim();
            if !s.is_empty() {
                texts.push(s.to_string());
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if is_transcript_key(k) || is_transcript_container(k) {
                    collect_transcript(v, texts);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_transcript(item, texts);
            }
        }
        _ => {}
    }
}

/// Keys whose string value is directly the recognized text.
fn is_transcript_key(k: &str) -> bool {
    matches!(
        k,
        "text" | "transcript" | "sentence" | "content" | "asr_output" | "recognition_result"
    )
}

/// Structural keys to descend into (they may hold `text` deeper down).
fn is_transcript_container(k: &str) -> bool {
    matches!(
        k,
        "payload" | "result" | "results" | "sentence" | "sentences" | "transcripts" | "output"
    )
}
