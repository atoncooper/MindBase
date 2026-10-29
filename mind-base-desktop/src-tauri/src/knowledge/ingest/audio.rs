//! 媒体产物落盘：媒体目录解析、音频/视频临时路径与 ffmpeg 音轨抽取。

use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use tauri::State;

use crate::infra::db::Db;

/// Persistent media directory under the app data dir (host of the SQLite db),
/// where downloaded audio/video and extracted WAVs are kept for inspection.
pub(super) fn media_dir_of(db: &State<'_, Db>) -> Result<PathBuf, String> {
    let dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(dir.join("media"))
}

/// Persistent download destination for one 分P's DASH audio stream.
pub(super) fn audio_tmp_path(media_dir: &Path, bvid: &str, cid: i64) -> PathBuf {
    media_dir.join(format!("{bvid}_{cid}.m4s"))
}

/// Persistent combined-video destination for the audio-extraction fallback.
pub(super) fn combined_tmp_path(media_dir: &Path, bvid: &str, cid: i64) -> PathBuf {
    media_dir.join(format!("{bvid}_{cid}_comb.mp4"))
}

/// Extract the audio track from a local video file via ffmpeg, producing a
/// 16k mono WAV that DashScope accepts. Returns the output path.
pub(super) fn extract_audio_with_ffmpeg(
    video_path: &Path,
    media_dir: &Path,
    ffmpeg_bin: Option<&Path>,
) -> Result<PathBuf, String> {
    let program = match ffmpeg_bin {
        Some(p) => p.as_os_str().to_owned(),
        None => std::ffi::OsString::from("ffmpeg"),
    };
    let dir = media_dir.to_path_buf();
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("无法创建临时目录 {}：{err}", dir.display()))?;
    let tag = format!(
        "mb-extract-{}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let out = dir.join(format!("{tag}.wav"));

    let run = (|| -> Result<(), String> {
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = StdCommand::new(&program);
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(windows))]
        let mut cmd = StdCommand::new(&program);
        let status = cmd
            .arg("-y")
            .arg("-i")
            .arg(video_path)
            .arg("-vn") // drop video, keep audio
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg(&out)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|err| {
                format!(
                    "无法运行 ffmpeg（{}，{err}）以提取音轨；请安装 ffmpeg 并在「API 设置」或系统 PATH 中提供",
                    program.to_string_lossy()
                )
            })?;
        if !status.success() {
            return Err("ffmpeg 提取音轨失败（视频无法解码出音频）".to_string());
        }
        Ok(())
    })();
    match run {
        Ok(()) if out.exists() => Ok(out),
        Ok(_) => Err("ffmpeg 未生成音轨文件".to_string()),
        Err(err) => Err(err),
    }
}
