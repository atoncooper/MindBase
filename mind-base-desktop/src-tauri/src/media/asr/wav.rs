//! Audio container helpers: WAV→PCM extraction, ffmpeg transcoding and the probe tone.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use super::client::AsrClient;
use super::types::StageLog;

impl AsrClient {
    /// Normalize arbitrary input audio into raw 16-bit mono 16 kHz PCM, the
    /// only format the DashScope real-time ASR endpoint accepts.
    ///
    /// A WAV that is already 16k mono 16-bit is decoded in-process (no ffmpeg
    /// needed); anything else is transcoded with ffmpeg (configured path, else
    /// `ffmpeg` on PATH). Without ffmpeg and with a non-conforming container a
    /// clear, actionable error is returned.
    pub(super) fn to_pcm_bytes(
        &self,
        bytes: &[u8],
        content_type: &str,
        on_stage: &StageLog,
    ) -> Result<Vec<u8>, String> {
        if let Some(pcm) = extract_wav_pcm(bytes) {
            return Ok(pcm);
        }
        let ext = match content_type {
            "audio/wav" => "wav",
            "audio/mpeg" => "mp3",
            "audio/mp4" => "m4a",
            _ => "bin",
        };
        on_stage(&format!("ffmpeg 转码 {ext} → 16k PCM"));
        self.transcode_with_ffmpeg(bytes, ext)
    }

    /// Run ffmpeg to decode `bytes` into raw 16k mono 16-bit PCM.
    fn transcode_with_ffmpeg(&self, bytes: &[u8], ext: &str) -> Result<Vec<u8>, String> {
        let program = match &self.ffmpeg_path {
            Some(path) => path.as_os_str().to_owned(),
            None => std::ffi::OsString::from("ffmpeg"),
        };

        let tag = format!(
            "mb-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let dir = std::env::temp_dir().join("mindbase-desktop");
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建临时目录 {}：{err}", dir.display()))?;
        let input = dir.join(format!("{tag}.{ext}"));
        let output = dir.join(format!("{tag}.pcm"));

        let mut file =
            std::fs::File::create(&input).map_err(|err| format!("创建临时音频失败：{err}"))?;
        file.write_all(bytes)
            .map_err(|err| format!("写入临时音频失败：{err}"))?;
        drop(file);

        let result = (|| -> Result<(), String> {
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
                .arg(&input)
                .arg("-f")
                .arg("s16le")
                .arg("-ar")
                .arg("16000")
                .arg("-ac")
                .arg("1")
                .arg("-vn")
                .arg(&output)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .status()
                .map_err(|err| {
                    format!(
                        "无法运行 ffmpeg（{}，{err}）；请安装 ffmpeg 并在「API 设置」或系统 PATH 中提供，以将音频转为实时 ASR 所需的 PCM",
                        program.to_string_lossy()
                    )
                })?;
            if !status.success() {
                return Err("ffmpeg 转换失败（音频无法解码为 PCM）".to_string());
            }
            Ok(())
        })();

        // Always clean up the intermediate input file.
        let _ = std::fs::remove_file(&input);
        match result {
            Ok(()) => match std::fs::read(&output) {
                Ok(pcm) => {
                    let _ = std::fs::remove_file(&output);
                    if pcm.is_empty() {
                        Err("ffmpeg 转换结果为空".to_string())
                    } else {
                        Ok(pcm)
                    }
                }
                Err(err) => {
                    let _ = std::fs::remove_file(&output);
                    Err(format!("读取转换结果失败：{err}"))
                }
            },
            Err(err) => {
                let _ = std::fs::remove_file(&output);
                Err(err)
            }
        }
    }

    /// Transcode an arbitrary audio file to a 16k mono WAV, which DashScope's
    /// async Transcription reliably decodes (mirrors the backend's
    /// `_transcode_audio_to_wav`). Returns the output WAV path.
    pub(super) fn transcode_to_wav_file(
        &self,
        input: &Path,
        on_stage: &StageLog,
    ) -> Result<PathBuf, String> {
        let program = match &self.ffmpeg_path {
            Some(path) => path.as_os_str().to_owned(),
            None => std::ffi::OsString::from("ffmpeg"),
        };
        on_stage("ffmpeg 转码音频 → 16k 单声道 WAV");
        let dir = std::env::temp_dir().join("mindbase-desktop");
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建临时目录 {}：{err}", dir.display()))?;
        let tag = format!(
            "mb-wav-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let out = dir.join(format!("{tag}.wav"));

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
            .arg(input)
            .arg("-vn")
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
                    "无法运行 ffmpeg（{}，{err}）以转码音频；请安装 ffmpeg 并在「API 设置」或系统 PATH 中提供",
                    program.to_string_lossy()
                )
            })?;
        if !status.success() {
            return Err("ffmpeg 转码音频失败（无法解码为 16k WAV）".to_string());
        }
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or_default();
        if size < 1024 {
            let _ = std::fs::remove_file(&out);
            return Err("ffmpeg 转码输出无效（过小）".to_string());
        }
        Ok(out)
    }
}

/// Minimal mime guess for the audio containers B站 serves (.m4s/.m4a/mp4…).
pub(super) fn guess_audio_mime(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".m4s") || lower.ends_with(".m4a") || lower.ends_with(".mp4") {
        "audio/mp4"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else {
        "application/octet-stream"
    }
}

/// Append the OpenAI-compatible transcription resource to a Base URL without
/// doubling it — a Base URL may already end in `/audio/transcriptions` (e.g.
/// a user pastes the full endpoint), or be a bare `…/v1` root.
pub(super) fn openai_transcribe_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/audio/transcriptions")
    }
}

/// Extract raw PCM from a WAV container when it is already 16-bit, mono,
/// 16 kHz — the shape the real-time ASR endpoint expects — so no ffmpeg call
/// is needed for the common probe / hand-prepared case. Returns `None` when
/// the buffer is not a WAV, or when it needs resampling (→ ffmpeg).
pub(super) fn extract_wav_pcm(bytes: &[u8]) -> Option<Vec<u8>> {
    // Minimal RIFF/WAVE validation.
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (audio_format, channels, rate, bits)
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let body = offset + 8;
        match id {
            b"fmt " => {
                if body + 16 <= bytes.len() {
                    let audio_format = u16::from_le_bytes(bytes[body..body + 2].try_into().ok()?);
                    let channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().ok()?);
                    let rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?);
                    let bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().ok()?);
                    fmt = Some((audio_format, channels, rate, bits));
                }
            }
            b"data" => {
                let end = body + size;
                if end <= bytes.len() {
                    data = Some(&bytes[body..end]);
                }
            }
            _ => {}
        }
        // Chunks are 2-byte aligned.
        offset = body + size + (size & 1);
    }
    let (audio_format, channels, rate, bits) = fmt?;
    if audio_format != 1 || channels != 1 || rate != 16_000 || bits != 16 {
        return None;
    }
    data.map(|d| d.to_vec())
}

/// Build a short mono 16-bit PCM WAV (a soft 440Hz tone) used as a cheap
/// provider-acceptable payload for the end-to-end ASR probe. A tone is used
/// instead of pure silence so some ASR models don't reject it outright.
pub(super) fn tiny_wav() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const DURATION_SECS: f32 = 0.5;
    const FREQ: f32 = 440.0;
    let sample_count = (SAMPLE_RATE as f32 * DURATION_SECS) as usize;
    let data_len = sample_count * 2;

    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for i in 0..sample_count {
        let t = i as f32 / SAMPLE_RATE as f32;
        let sample = (0.3 * (2.0 * std::f32::consts::PI * FREQ * t).sin() * 32767.0) as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}
