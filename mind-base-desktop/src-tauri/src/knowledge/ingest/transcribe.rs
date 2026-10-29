//! 转写兜底链：URL 直传 → 本地下载音频 → 合并视频抽音轨。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;

use crate::knowledge::bilibili::content as bili_content;
use crate::media::asr::{AsrClient, StageLog};

use super::audio::{combined_tmp_path, extract_audio_with_ffmpeg};
use super::{emit, IngestEvent};

/// Wall-clock cap for one transcription task.
const TRANSCRIBE_DEADLINE: Duration = Duration::from_secs(600);
/// Short budget for the URL pass-through step: handing the B站 CDN URL to the
/// provider server-side usually fails (hotlink protection) or stalls, so cap
/// it well below the full transcription deadline to avoid blocking a page.
const URL_DIRECT_DEADLINE: Duration = Duration::from_secs(60);

/// Transcribe the real audio for one 分P, trying in order:
///   1. hand the DASH audio URL to the provider (DashScope fetches it server-
///      side) — commonly fails because B站 DASH CDN is hotlink-protected;
///   2. download the DASH audio stream locally and transcribe it;
///   3. if the audio stream can't be downloaded, download the **combined
///      video** (audio + video in one file) and extract the audio track with
///      ffmpeg, then transcribe that.
/// Every step uploads the real audio to the provider's temp OSS (async
/// Transcription). It never degrades to a non-transcribed fallback.
pub(super) fn transcribe_audio(
    page_index: i64,
    bvid: &str,
    cid: i64,
    media_dir: &Path,
    audio_url: &str,
    cookie: &str,
    tmp_dest: &std::path::Path,
    agent: &ureq::Agent,
    asr_client: &AsrClient,
    channel: &Channel<IngestEvent>,
) -> Result<String, String> {
    let mut on_wait = |elapsed_secs: u64| {
        emit(
            &IngestEvent::AsrWait {
                index: page_index,
                elapsed_secs,
            },
            channel,
        );
    };
    let on_stage_channel = channel.clone();
    let on_stage: StageLog = Arc::new(move |stage: &str| {
        emit(
            &IngestEvent::PageStep {
                index: page_index,
                step: format!("asr · {stage}"),
            },
            &on_stage_channel,
        );
    });

    // 1. Hand the DASH audio URL to the provider (DashScope fetches it
    //    server-side). B站 DASH CDN is hotlink-protected, so this commonly
    //    fails — fall through to local acquisition either way.
    let reachable = bili_content::probe_audio_url(audio_url);
    crate::infra::logging::info(
        "ingest",
        &format!("step1 URL reachable={reachable} url={audio_url}"),
    );
    if reachable {
        match asr_client.transcribe_url(audio_url, URL_DIRECT_DEADLINE, &mut on_wait, &on_stage) {
            Ok(text) if !text.trim().is_empty() => {
                crate::infra::logging::info(
                    "ingest",
                    &format!("step1 URL transcribe ok len={}", text.chars().count()),
                );
                return Ok(text);
            }
            Ok(_) => {
                crate::infra::logging::warn("ingest", "step1 URL transcribe empty, fall through to local");
                on_stage("URL 转写结果为空，改为本地下载音频");
            }
            Err(url_err) => {
                crate::infra::logging::warn("ingest", &format!("step1 URL transcribe failed: {url_err}"));
                on_stage(&format!("URL 转写失败，改为本地下载音频：{url_err}"));
            }
        }
    }

    // 2. Download the DASH audio stream locally and transcribe it.
    if let Some(parent) = tmp_dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("无法创建临时目录 {}：{err}", parent.display()))?;
    }
    match bili_content::download_audio(audio_url, Some(cookie), tmp_dest) {
        Ok(path) => {
            crate::infra::logging::info(
                "ingest",
                &format!(
                    "step2 audio downloaded bytes={} path={}",
                    std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    path.display()
                ),
            );
            let result = asr_client.transcribe_local_file(
                &path, TRANSCRIBE_DEADLINE, &mut on_wait, &on_stage,
            );
            // Downloaded audio is persisted in the media dir for inspection.
            match result {
                Ok(text) if !text.trim().is_empty() => {
                    crate::infra::logging::info(
                        "ingest",
                        &format!("step2 local transcribe ok len={}", text.chars().count()),
                    );
                    return Ok(text);
                }
                Ok(_) => {
                    crate::infra::logging::warn("ingest", "step2 local transcribe empty");
                    on_stage("音频流转写结果为空，尝试下载视频提取音轨");
                }
                Err(err) => {
                    crate::infra::logging::error("ingest", &format!("step2 local transcribe failed: {err}"));
                    on_stage(&format!("音频流转写失败：{err}，尝试下载视频提取音轨"));
                }
            }
        }
        Err(audio_err) => {
            crate::infra::logging::error("ingest", &format!("step2 audio download failed: {audio_err}"));
            on_stage(&format!("音频流下载失败：{audio_err}，尝试下载视频提取音轨"));
        }
    }

    // 3. Fallback: download the combined video (audio + video in one file),
    //    extract the audio track with ffmpeg, then transcribe that.
    transcribe_from_combined_video(page_index, bvid, cid, media_dir, cookie, agent, asr_client, channel)
}

/// Fallback path used when the separate DASH audio stream can't be resolved
/// (`fetch_audio_url` → `None`) or can't be downloaded: download the
/// **combined** video (audio + video in one file), extract the audio track
/// with ffmpeg, then transcribe it — which uploads the real audio to the
/// provider's temp OSS (async Transcription). Never degrades to a
/// non-transcribed fallback.
pub(super) fn transcribe_from_combined_video(
    page_index: i64,
    bvid: &str,
    cid: i64,
    media_dir: &Path,
    cookie: &str,
    agent: &ureq::Agent,
    asr_client: &AsrClient,
    channel: &Channel<IngestEvent>,
) -> Result<String, String> {
    let mut on_wait = |elapsed_secs: u64| {
        emit(
            &IngestEvent::AsrWait {
                index: page_index,
                elapsed_secs,
            },
            channel,
        );
    };
    let on_stage_channel = channel.clone();
    let on_stage: StageLog = Arc::new(move |stage: &str| {
        emit(
            &IngestEvent::PageStep {
                index: page_index,
                step: format!("asr · {stage}"),
            },
            &on_stage_channel,
        );
    });

    on_stage("下载合并视频并用 ffmpeg 提取音轨");
    let combined_url = bili_content::fetch_combined_url(agent, Some(cookie), bvid, cid)?
        .ok_or("该分P 无可用合并视频流（含音轨）")?;
    let video_tmp = combined_tmp_path(media_dir, bvid, cid);
    let video_path = bili_content::download_audio(&combined_url, Some(cookie), &video_tmp)?;
    let audio_path = extract_audio_with_ffmpeg(&video_path, media_dir, asr_client.ffmpeg_bin())?;
    let result = asr_client.transcribe_local_file(
        &audio_path, TRANSCRIBE_DEADLINE, &mut on_wait, &on_stage,
    );
    // Downloaded video + extracted WAV are persisted in the media dir.
    result
}
