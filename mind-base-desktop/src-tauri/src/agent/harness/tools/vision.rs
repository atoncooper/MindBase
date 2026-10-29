//! Vision attachments: collect and downscale the original images of knowledge-base image hits.

use rusqlite::{Connection, OptionalExtension};

use super::super::registry::ToolContext;
use crate::knowledge::ingest::KnowledgeHit;

// ---------------------------------------------------------------------------
// vision attachments (视觉模型读图) — when the configured chat model is
// vision-capable AND the user opted in (config.visionEnabled), image-file
// knowledge-base hits carry their original picture (downscaled through the
// bundled ffmpeg) alongside the OCR text: charts, layout and diagrams that
// OCR cannot express reach the model as real images. Best-effort — any
// failure in the pipeline silently degrades to text-only.
// ---------------------------------------------------------------------------

/// Max images attached per vector_search call.
const VISION_MAX_IMAGES: usize = 3;
/// Longest edge of the downscaled JPEG sent to the model.
const VISION_MAX_EDGE: u32 = 1024;

pub(super) fn collect_vision_images(ctx: &ToolContext, hits: &[KnowledgeHit]) -> Vec<String> {
    // 开关一：模型能力（名称启发式）。
    let Some(client) = ctx.chat_client.as_deref() else {
        return Vec::new();
    };
    if !crate::llm::client::model_supports_vision(client.model_name()) {
        return Vec::new();
    }
    // 开关二：用户隐私开关（AppConfig.visionEnabled，默认关——
    // 开启意味着命中的原图会以 base64 发往云端）。
    let enabled = (|| {
        let conn = ctx.db.conn.lock().ok()?;
        crate::infra::config::load(&conn)
            .ok()
            .map(|cfg| cfg.vision_enabled)
    })()
    .unwrap_or(false);
    if !enabled {
        return Vec::new();
    }
    let Some(ffmpeg) = crate::media::ffmpeg::cached_ffmpeg_path() else {
        return Vec::new();
    };

    // 去重文档，按命中顺序（相关度）取前 N 张。
    let mut seen = std::collections::HashSet::new();
    let mut targets: Vec<&KnowledgeHit> = Vec::new();
    for hit in hits {
        if seen.insert(hit.doc_id.clone()) {
            targets.push(hit);
            if targets.len() >= VISION_MAX_IMAGES {
                break;
            }
        }
    }

    // 先在锁内取齐所有原图路径，再做缩放（ffmpeg 子进程不占数据库锁）。
    let mut images = Vec::new();
    let paths: Vec<std::path::PathBuf> = {
        let Some(conn) = ctx.db.conn.lock().ok() else {
            return images;
        };
        targets
            .iter()
            .filter_map(|hit| vision_source_path(&conn, &hit.doc_id))
            .collect()
    };
    for path in paths {
        if let Ok(bytes) = downscale_to_jpeg(&ffmpeg, &path, VISION_MAX_EDGE) {
            use base64::Engine as _;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            images.push(format!("data:image/jpeg;base64,{encoded}"));
        }
    }
    images
}

/// Original image path of a file-sourced document — image extensions only,
/// and only when the file still exists at its import location.
fn vision_source_path(conn: &Connection, doc_id: &str) -> Option<std::path::PathBuf> {
    let path: String = conn
        .query_row(
            "SELECT file_path FROM documents WHERE doc_id = ?1 AND source_type = 'file'",
            rusqlite::params![doc_id],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let path = std::path::PathBuf::from(path);
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp") {
        return None;
    }
    path.is_file().then_some(path)
}

/// Downscale an image to JPEG (longest edge ≤ max_edge, downscale-only) via
/// the bundled ffmpeg — no new dependency, and the ASR pipeline already
/// ships the binary.
fn downscale_to_jpeg(
    ffmpeg: &std::path::Path,
    input: &std::path::Path,
    max_edge: u32,
) -> Result<Vec<u8>, String> {
    let output = std::env::temp_dir().join(format!(
        "mb-vision-{}-{}.jpg",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let status = std::process::Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vf")
        .arg(format!(
            "scale=w={max_edge}:h={max_edge}:force_original_aspect_ratio=decrease"
        ))
        .args(["-q:v", "4"])
        .arg(&output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|err| format!("ffmpeg 启动失败：{err}"))?;
    if !status.success() {
        return Err(format!("ffmpeg 退出码 {status}"));
    }
    let bytes = std::fs::read(&output).map_err(|err| format!("读取缩放结果失败：{err}"))?;
    let _ = std::fs::remove_file(&output);
    Ok(bytes)
}
