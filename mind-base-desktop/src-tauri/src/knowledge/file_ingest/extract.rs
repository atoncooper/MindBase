//! Python 侧文本抽取（`doc_extract.py`）与其 JSON 结果的解析。

use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use serde::Deserialize;

use super::types::Extracted;

// ---------------------------------------------------------------------------
// Python-side text extraction
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct ExtractPayload {
    #[serde(default)]
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) text: String,
    #[serde(default)]
    pub(super) error: String,
}

/// Path of the extraction script, shipped as a resource next to the binary.
fn script_path() -> PathBuf {
    // dev: CARGO_MANIFEST_DIR/scripts; packaged: resources/scripts
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("doc_extract.py");
    if dev.exists() {
        return dev;
    }
    std::path::Path::new("scripts")
        .join("doc_extract.py")
        .to_path_buf()
}

/// Parse the one-JSON-line verdict printed by `doc_extract.py` /
/// `ocr_extract.py` (the verdict is the LAST non-empty stdout line — libs
/// like pymupdf may print warnings above it).
pub(super) fn parse_extract_payload(stdout: &str) -> Result<ExtractPayload, String> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or("");
    serde_json::from_str(line).map_err(|err| {
        let snippet: String = line.chars().take(120).collect();
        format!("解析器输出无法读取：{err}（输出片段：{snippet}）")
    })
}

/// Run `doc_extract.py` on one file and parse its JSON verdict.
pub(super) fn extract_text(exe: &Path, file: &Path) -> Result<Extracted, String> {
    let script = script_path();
    if !script.is_file() {
        return Err(format!("解析脚本缺失：{}", script.display()));
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = StdCommand::new(exe);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = StdCommand::new(exe);
    let output = cmd
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(&script)
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|err| format!("无法运行解析器（{}）：{err}", exe.display()))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!("解析器异常退出（退出码 {}）", output.status));
    }
    let payload = parse_extract_payload(&String::from_utf8_lossy(&output.stdout))?;
    if !payload.ok {
        return Err(if payload.error.is_empty() {
            "解析失败（未知原因）".to_string()
        } else {
            payload.error
        });
    }
    Ok(Extracted {
        title: payload.title,
        text: payload.text,
    })
}
