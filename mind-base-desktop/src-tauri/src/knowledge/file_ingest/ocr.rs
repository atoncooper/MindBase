//! 本地 OCR 兜底：运行状态、不可用原因与识别执行。

use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use super::extract::parse_extract_payload;
use super::types::Extracted;

// ---------------------------------------------------------------------------
// OCR fallback (local RapidOCR, see `ocr_server.rs` + `scripts/ocr_extract.py`)
// ---------------------------------------------------------------------------

/// Availability of the local OCR runtime for one ingestion run.
pub(super) enum OcrStatus {
    /// Everything needed to run `ocr_extract.py` is in place.
    Ready {
        exe: PathBuf,
        model_dir: PathBuf,
        device: String,
    },
    /// The user has not switched OCR to 本地部署.
    Disabled,
    /// Local OCR is on but the configured bundle is not downloaded.
    NoModel { model: String },
    /// Local OCR is on but the environment could not be provisioned.
    Failed(String),
}

impl OcrStatus {
    /// The user-facing reason OCR cannot run right now.
    pub(super) fn unavailable_reason(&self, for_image: bool) -> String {
        let subject = if for_image {
            "图片入库走本地 OCR 识别"
        } else {
            "该 PDF 是扫描版（无文本层），需要 OCR 识别"
        };
        match self {
            OcrStatus::Ready { .. } => String::new(),
            OcrStatus::Disabled => format!(
                "{subject}。请到「API 设置 → OCR 文字识别」切换到本地部署并下载模型后重试"
            ),
            OcrStatus::NoModel { model } => format!(
                "{subject}。本地 OCR 模型「{model}」尚未下载：请在「API 设置 → 本地 OCR 模型」卡片下载"
            ),
            OcrStatus::Failed(err) => format!("{subject}，但本地 OCR 环境不可用：{err}"),
        }
    }
}

/// `true` when the extractor error is the scanned-PDF verdict (no text
/// layer) that should trigger the OCR fallback.
pub(super) fn is_scanned_pdf_error(error: &str) -> bool {
    error.contains("没有可提取的文本层")
}

/// Path of the OCR script, shipped as a resource next to the binary.
fn ocr_script_path() -> PathBuf {
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("ocr_extract.py");
    if dev.exists() {
        return dev;
    }
    std::path::Path::new("scripts").join("ocr_extract.py").to_path_buf()
}

/// Run `ocr_extract.py` on one image / scanned PDF and parse its verdict.
pub(super) fn ocr_extract(ctx: (&Path, &Path, &str), file: &Path) -> Result<Extracted, String> {
    let (exe, model_dir, device) = ctx;
    let script = ocr_script_path();
    if !script.is_file() {
        return Err(format!("OCR 脚本缺失：{}", script.display()));
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
        .arg(model_dir)
        .arg(device)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|err| format!("无法运行 OCR（{}）：{err}", exe.display()))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!("OCR 异常退出（退出码 {}）", output.status));
    }
    let payload = parse_extract_payload(&String::from_utf8_lossy(&output.stdout))?;
    if !payload.ok {
        return Err(if payload.error.is_empty() {
            "OCR 识别失败（未知原因）".to_string()
        } else {
            payload.error
        });
    }
    Ok(Extracted {
        title: payload.title,
        text: payload.text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanned_pdf_errors_are_recognized() {
        assert!(is_scanned_pdf_error(
            "该 PDF 没有可提取的文本层（可能是扫描件），暂不支持 OCR"
        ));
        assert!(!is_scanned_pdf_error("无法打开 PDF：corrupt"));
        assert!(!is_scanned_pdf_error("该 DOCX 没有可提取的正文"));
    }

    #[test]
    fn ocr_unavailable_reasons_distinguish_states() {
        let disabled = OcrStatus::Disabled;
        let msg = disabled.unavailable_reason(false);
        assert!(msg.contains("API 设置"), "disabled should point at settings: {msg}");
        let no_model = OcrStatus::NoModel { model: "pp-ocrv4-mobile".to_string() };
        let msg = no_model.unavailable_reason(true);
        assert!(msg.contains("pp-ocrv4-mobile") && msg.contains("下载"), "{msg}");
        let failed = OcrStatus::Failed("boom".to_string());
        assert!(failed.unavailable_reason(false).contains("boom"));
    }
}
