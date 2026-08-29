//! Ingestion orchestration: B站 video → ASR text → chunks → embeddings →
//! the built-in vector store, plus the workspace search/QA commands.
//!
//! Pipeline per 分P (sequential, mirroring the backend's conservative
//! pacing): outline → audio URL → transcribe (URL or download+OSS) →
//! chunk → embed → one short-lock transaction that rewrites vectors and the
//! documents row together. Any per-page failure marks that page `failed` and
//! the run continues — one bad video never blocks the rest.
//!
//! Concurrency note: v1 is deliberately single-flight (the frontend keeps
//! its ingest button busy); no global queue exists Rust-side yet.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::asr::{AsrClient, StageLog};
use crate::bilibili::content as bili_content;
use crate::bilibili::require_session;
use crate::chunker;
use crate::embeddings::{embed_client_from_conn, EmbedClient};
use crate::vectors::{self, SearchHit};
use crate::db::Db;

/// Pause between pages — the backend's B站-friendliness pacing.
const PAGE_PACING: Duration = Duration::from_millis(500);
/// Default hits returned by workspace search.
const DEFAULT_TOP_K: u32 = 8;
/// Wall-clock cap for one transcription task.
const TRANSCRIBE_DEADLINE: Duration = Duration::from_secs(600);
/// Short budget for the URL pass-through step: handing the B站 CDN URL to the
/// provider server-side usually fails (hotlink protection) or stalls, so cap
/// it well below the full transcription deadline to avoid blocking a page.
const URL_DIRECT_DEADLINE: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/// One progress update pushed to the frontend during ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IngestEvent {
    Start { bvid: String, total_pages: u32 },
    PageStart { index: i64, page_title: String },
    /// `step`: conclusion | audio | asr | chunk | embed | store.
    PageStep { index: i64, step: String },
    /// ASR wait heartbeat (`elapsed_secs` since the task was submitted).
    AsrWait { index: i64, elapsed_secs: u64 },
    PageDone {
        index: i64,
        doc_id: String,
        chunks: usize,
        source: String,
    },
    PageFailed { index: i64, error: String },
    Done { ok: usize, failed: usize },
}

fn emit(event: &IngestEvent, channel: &Channel<IngestEvent>) {
    // A closed channel (window navigated away) must never abort ingestion.
    let _ = channel.send(event.clone());
}

// ---------------------------------------------------------------------------
// Document rows
// ---------------------------------------------------------------------------

/// One ingested 分P, as shown in the workspace document list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRow {
    pub doc_id: String,
    pub bvid: String,
    pub page_index: i64,
    pub video_title: String,
    pub page_title: String,
    /// asr | basic_info | file extension
    pub source: String,
    /// done | failed | processing | pending
    pub status: String,
    pub error: String,
    pub chunk_count: i64,
    pub char_count: i64,
    pub embed_model: String,
    pub embed_dim: i64,
    pub updated_at: i64,
    pub url: String,
    /// video | file — file documents carry an absolute local path instead of
    /// a B站 identity.
    pub source_type: String,
    pub file_path: String,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// Canonical doc id for one 分P.
fn doc_id_of(bvid: &str, page_index: i64) -> String {
    format!("{bvid}:p{page_index}")
}

/// Canonical B站 watch URL for one 分P.
fn page_url(bvid: &str, page_index: i64) -> String {
    format!("https://www.bilibili.com/video/{bvid}?p={page_index}")
}

/// Identity facts of one 分P, shared by the documents-row writers.
struct PageIdentity<'a> {
    doc_id: &'a str,
    bvid: &'a str,
    cid: i64,
    page_index: i64,
    video_title: &'a str,
    page_title: &'a str,
    upper_name: &'a str,
}

/// Insert-or-update a documents row while a page is in flight.
fn upsert_document_status(
    conn: &rusqlite::Connection,
    page: &PageIdentity<'_>,
    status: &str,
    error: &str,
) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO documents(doc_id, bvid, cid, page_index, video_title, page_title,
                               upper_name, source, status, error, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?10)
         ON CONFLICT(doc_id) DO UPDATE SET
             cid = excluded.cid,
             video_title = excluded.video_title,
             page_title = excluded.page_title,
             upper_name = excluded.upper_name,
             status = excluded.status,
             error = excluded.error,
             updated_at = excluded.updated_at",
        params![
            page.doc_id,
            page.bvid,
            page.cid,
            page.page_index,
            page.video_title,
            page.page_title,
            page.upper_name,
            status,
            error,
            now
        ],
    )
    .map_err(|err| format!("failed to update document status: {err}"))?;
    Ok(())
}

/// Finalize a documents row with its produced-content facts.
fn mark_document_done(
    conn: &rusqlite::Connection,
    doc_id: &str,
    source: &str,
    chunk_count: usize,
    char_count: usize,
    embed_model: &str,
    embed_dim: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE documents
         SET status = 'done', error = '', source = ?2, chunk_count = ?3,
             char_count = ?4, embed_model = ?5, embed_dim = ?6, updated_at = ?7
         WHERE doc_id = ?1",
        params![
            doc_id,
            source,
            chunk_count as i64,
            char_count as i64,
            embed_model,
            embed_dim,
            now_secs()
        ],
    )
    .map_err(|err| format!("failed to finalize document: {err}"))?;
    Ok(())
}

fn mark_document_failed(
    conn: &rusqlite::Connection,
    doc_id: &str,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET status = 'failed', error = ?2, updated_at = ?3 WHERE doc_id = ?1",
        params![doc_id, error, now_secs()],
    )
    .map_err(|err| format!("failed to mark document failed: {err}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Ingestion command
// ---------------------------------------------------------------------------

/// Outcome summary of one ingestion run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub ok: usize,
    pub failed: usize,
}

/// Ingest one or every 分P of a video into the local knowledge base.
#[tauri::command]
pub async fn ingest_video(
    app: AppHandle,
    bvid: String,
    page_index: Option<i64>,
    on_event: Channel<IngestEvent>,
) -> Result<IngestSummary, String> {
    let bvid = bvid.trim().to_string();
    if !bvid.starts_with("BV") || bvid.len() != 12 {
        return Err("bvid 格式无效".to_string());
    }

    // Precheck credentials before touching any state: login (for reliable
    // playurl/CDN access) and the ASR/embedding configuration. The local ASR
    // server is started AFTER the DB lock is released — first-run
    // provisioning (pip deps + model download) takes minutes and must not
    // block every other command on the database mutex.
    enum AsrTarget {
        Cloud { key: String, base: Option<String>, model: String },
        Local { cfg: crate::config::LocalAsrConfig, data_dir: PathBuf },
    }
    let (session_cookie, asr_target, ffmpeg_path, embed_client) = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let session = require_session(&conn)?;
        // Only the real-time WebSocket ASR path needs ffmpeg (to transcode
        // audio to PCM). Resolve it from override → bundled → PATH; a missing
        // binary is non-fatal here because the transcoder retries `ffmpeg` on
        // PATH and WAV inputs never need it.
        let cfg = crate::config::load(&conn)?;
        crate::logging::info(
            "ingest",
            &format!(
                "[diag] local_asr.enabled={} port={} model={}",
                cfg.local_asr.enabled,
                cfg.local_asr.port,
                cfg.local_asr.model,
            ),
        );
        let ffmpeg_path =
            crate::ffmpeg::resolve_ffmpeg_path(&app, cfg.ffmpeg_path_override.as_deref()).ok();
        let data_dir = db
            .data_dir
            .lock()
            .map(|dir| dir.clone())
            .ok();
        // 方案 A：本地 ASR 启用时把 ASR 路由到本地服务（应用启动时已拉起，
        // 这里兜底确保可用）；云端 asr 槽未配置 Key 时也自动回退本地服务
        // （首次会自动安装依赖并下载模型），而不是直接报错。
        let asr_target = if cfg.local_asr.enabled {
            let dir = data_dir.ok_or("数据目录不可用，无法启动本地 ASR 服务")?;
            AsrTarget::Local { cfg: cfg.local_asr.clone(), data_dir: dir }
        } else {
            match crate::asr::resolve_api_key(&conn) {
                Ok(key) => AsrTarget::Cloud {
                    key,
                    base: crate::asr::resolve_base_url(&conn)?,
                    model: crate::asr::resolve_model(&conn)?,
                },
                Err(_) => {
                    crate::logging::warn(
                        "ingest",
                        "未配置云端 ASR API Key，自动回退本地 ASR（首次使用将自动安装依赖并下载模型）",
                    );
                    let dir = data_dir.ok_or("数据目录不可用，无法启动本地 ASR 服务")?;
                    AsrTarget::Local { cfg: cfg.local_asr.clone(), data_dir: dir }
                }
            }
        };
        let embed_client = embed_client_from_conn(&conn)?;
        (session.cookie_header(), asr_target, ffmpeg_path, embed_client)
    };

    let asr_client = match asr_target {
        AsrTarget::Cloud { key, base, model } => {
            AsrClient::with_base_and_ffmpeg(key, model, base, ffmpeg_path, None)?
        }
        AsrTarget::Local { cfg, data_dir } => {
            // Server start can block for minutes on first-run provisioning —
            // keep it off the async runtime.
            let model = cfg.model.clone();
            let spawn_cfg = cfg;
            let spawn_dir = data_dir.clone();
            let base = tauri::async_runtime::spawn_blocking(move || {
                crate::whisper_server::ensure_running(&spawn_cfg, &spawn_dir)
            })
            .await
            .map_err(|err| format!("本地 ASR 启动任务失败：{err}"))??;
            AsrClient::with_base_and_ffmpeg(
                // 本地服务不需要鉴权，传占位 key。
                "local-whisper".to_string(),
                model,
                Some(base),
                ffmpeg_path,
                Some(data_dir),
            )?
        }
    };

    // `State` borrows the app; the blocking worker re-resolves it from a
    // cloned handle instead of moving the borrow into a 'static closure.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        run_ingestion(
            &bvid,
            page_index,
            &session_cookie,
            &asr_client,
            &embed_client,
            &on_event,
            &db,
        )
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

fn run_ingestion(
    bvid: &str,
    only_index: Option<i64>,
    cookie: &str,
    asr_client: &AsrClient,
    embed_client: &EmbedClient,
    channel: &Channel<IngestEvent>,
    db: &State<'_, Db>,
) -> Result<IngestSummary, String> {
    let agent = crate::bilibili::build_agent()?;

    // Downloaded media (audio/video + extracted WAV) is persisted under the
    // app data directory so the user can inspect it — not the OS temp dir,
    // which is cleaned up and leaves nothing to verify.
    let media_dir = media_dir_of(db)?;
    std::fs::create_dir_all(&media_dir)
        .map_err(|err| format!("无法创建媒体目录 {}：{err}", media_dir.display()))?;

    // Video facts (title / desc / 分P list) come from one view call.
    let brief = bili_content::fetch_video_brief(&agent, Some(cookie), bvid)?;
    if brief.pages.is_empty() {
        return Err("该视频没有可入库的分P".to_string());
    }
    // Resolve which 分P indexes this run covers: one page when requested,
    // otherwise every page.
    let indexes: Vec<i64> = match only_index {
        Some(index) => {
            if brief.pages.iter().any(|page| page.index == index) {
                vec![index]
            } else {
                return Err(format!("该视频没有第 {index} 分P"));
            }
        }
        None => brief.pages.iter().map(|page| page.index).collect(),
    };
    emit(
        &IngestEvent::Start {
            bvid: bvid.to_string(),
            total_pages: indexes.len() as u32,
        },
        channel,
    );

    let mut ok = 0usize;
    let mut failed = 0usize;
    for (position, index) in indexes.iter().enumerate() {
        // Look up the page facts for this run's index (always present here).
        let page = brief
            .pages
            .iter()
            .find(|page| page.index == *index)
            .expect("index validated above");
        if position > 0 {
            std::thread::sleep(PAGE_PACING);
        }
        let doc_id = doc_id_of(bvid, page.index);
        emit(
            &IngestEvent::PageStart {
                index: page.index,
                page_title: page.part_title.clone(),
            },
            channel,
        );
        let identity = PageIdentity {
            doc_id: &doc_id,
            bvid,
            cid: page.cid,
            page_index: page.index,
            video_title: &brief.title,
            page_title: &page.part_title,
            upper_name: &brief.upper_name,
        };

        // Mark processing first so the UI reflects in-flight state.
        {
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            upsert_document_status(&conn, &identity, "processing", "")?;
        }

        match ingest_one_page(
            bvid,
            page.cid,
            page.index,
            &brief,
            &media_dir,
            cookie,
            &agent,
            asr_client,
            embed_client,
            channel,
        ) {
            Ok(outcome) => {
                // Single short-lock transaction: vectors + documents flip together.
                let conn = db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|err| format!("failed to begin transaction: {err}"))?;
                vectors::delete_doc_conn(&tx, &doc_id)?;
                vectors::upsert_chunks_conn(&tx, &doc_id, &outcome.chunks)?;
                // Store the actual embedding dimension produced by the
                // configured provider (it may differ from DashScope's 1024,
                // e.g. an OpenRouter model with a native dimension).
                let embed_dim = outcome
                    .chunks
                    .first()
                    .map(|chunk| chunk.embedding.len() as i64)
                    .unwrap_or(0);
                mark_document_done(
                    &tx,
                    &doc_id,
                    &outcome.source,
                    outcome.chunks.len(),
                    outcome.char_count,
                    embed_client.model_name(),
                    embed_dim,
                )?;
                tx.commit()
                    .map_err(|err| format!("failed to commit ingestion: {err}"))?;
                emit(
                    &IngestEvent::PageDone {
                        index: page.index,
                        doc_id,
                        chunks: outcome.chunks.len(),
                        source: outcome.source,
                    },
                    channel,
                );
                ok += 1;
            }
            Err(error) => {
                let conn = db
                    .conn
                    .lock()
                    .map_err(|err| format!("failed to acquire database lock: {err}"))?;
                mark_document_failed(&conn, &doc_id, &error)?;
                emit(
                    &IngestEvent::PageFailed {
                        index: page.index,
                        error: error.clone(),
                    },
                    channel,
                );
                failed += 1;
            }
        }
    }

    emit(&IngestEvent::Done { ok, failed }, channel);
    Ok(IngestSummary { ok, failed })
}

/// Facts produced by one successful page ingestion.
struct PageOutcome {
    chunks: Vec<vectors::UpsertChunk>,
    char_count: usize,
    source: String,
}

/// Text acquisition + chunking + embedding for one 分P (no DB access).
#[allow(clippy::too_many_arguments)]
fn ingest_one_page(
    bvid: &str,
    cid: i64,
    page_index: i64,
    brief: &bili_content::VideoBrief,
    media_dir: &Path,
    cookie: &str,
    agent: &ureq::Agent,
    asr_client: &AsrClient,
    embed_client: &EmbedClient,
    channel: &Channel<IngestEvent>,
) -> Result<PageOutcome, String> {
    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "conclusion".to_string(),
        },
        channel,
    );
    let outline_titles = bili_content::fetch_outline_titles(agent, Some(cookie), bvid, cid)
        .ok()
        .flatten()
        .unwrap_or_default();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "audio".to_string(),
        },
        channel,
    );
    let audio_url = bili_content::fetch_audio_url(agent, Some(cookie), bvid, cid)?;

    let text = match audio_url {
        Some(url) => {
            let tmp_dest = audio_tmp_path(media_dir, bvid, cid);
            match transcribe_audio(
                page_index,
                bvid,
                cid,
                media_dir,
                &url,
                cookie,
                &tmp_dest,
                agent,
                asr_client,
                channel,
            ) {
                Ok(text) if !text.trim().is_empty() => {
                    crate::logging::info(
                        "ingest",
                        &format!("page {page_index} ASR ok len={}", text.chars().count()),
                    );
                    text
                }
                other => {
                    // No silent degradation to title+desc: an ASR failure must
                    // surface as a page failure so the real error is visible and
                    // the knowledge base never stores non-transcribed text.
                    let note = match other {
                        Ok(_) => "转写结果为空".to_string(),
                        Err(error) => first_line(&error),
                    };
                    crate::logging::error(
                        "ingest",
                        &format!("page {page_index} ASR failed: {note}"),
                    );
                    return Err(format!("ASR 转写失败：{note}"));
                }
            }
        }
        None => {
            // No separate DASH audio stream could be resolved — instead of
            // failing the page outright, fall back to downloading the combined
            // video and extracting its audio track with ffmpeg, then
            // transcribe that (uploaded to the provider's temp OSS).
            transcribe_from_combined_video(
                page_index,
                bvid,
                cid,
                media_dir,
                cookie,
                agent,
                asr_client,
                channel,
            )?
        }
    };
    let source = "asr".to_string();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "chunk".to_string(),
        },
        channel,
    );
    let page_title = brief
        .pages
        .iter()
        .find(|page| page.cid == cid)
        .map(|page| page.part_title.clone());
    let chunk_results =
        chunker::chunk_text(&text, &brief.title, page_title.as_deref(), &outline_titles);
    if chunk_results.is_empty() {
        return Err("正文为空，无法入库".to_string());
    }
    let char_count = text.chars().count();

    emit(
        &IngestEvent::PageStep {
            index: page_index,
            step: "embed".to_string(),
        },
        channel,
    );
    let embedding_texts: Vec<String> = chunk_results
        .iter()
        .map(|chunk| chunk.embedding_text.clone())
        .collect();
    let embeddings = embed_client.embed_texts(&embedding_texts)?;

    let chunks: Vec<vectors::UpsertChunk> = chunk_results
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(index, (chunk, embedding))| vectors::UpsertChunk {
            index: index as i64,
            content: chunk.display_text,
            embedding,
        })
        .collect();

    Ok(PageOutcome {
        chunks,
        char_count,
        source,
    })
}

/// Persistent media directory under the app data dir (host of the SQLite db),
/// where downloaded audio/video and extracted WAVs are kept for inspection.
fn media_dir_of(db: &State<'_, Db>) -> Result<PathBuf, String> {
    let dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(dir.join("media"))
}

/// Persistent download destination for one 分P's DASH audio stream.
fn audio_tmp_path(media_dir: &Path, bvid: &str, cid: i64) -> PathBuf {
    media_dir.join(format!("{bvid}_{cid}.m4s"))
}

/// Transcribe the real audio for one 分P, trying in order:
///   1. hand the DASH audio URL to the provider (DashScope fetches it server-
///      side) — commonly fails because B站 DASH CDN is hotlink-protected;
///   2. download the DASH audio stream locally and transcribe it;
///   3. if the audio stream can't be downloaded, download the **combined
///      video** (audio + video in one file) and extract the audio track with
///      ffmpeg, then transcribe that.
/// Every step uploads the real audio to the provider's temp OSS (async
/// Transcription). It never degrades to a non-transcribed fallback.
fn transcribe_audio(
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
    crate::logging::info(
        "ingest",
        &format!("step1 URL reachable={reachable} url={audio_url}"),
    );
    if reachable {
        match asr_client.transcribe_url(audio_url, URL_DIRECT_DEADLINE, &mut on_wait, &on_stage) {
            Ok(text) if !text.trim().is_empty() => {
                crate::logging::info(
                    "ingest",
                    &format!("step1 URL transcribe ok len={}", text.chars().count()),
                );
                return Ok(text);
            }
            Ok(_) => {
                crate::logging::warn("ingest", "step1 URL transcribe empty, fall through to local");
                on_stage("URL 转写结果为空，改为本地下载音频");
            }
            Err(url_err) => {
                crate::logging::warn("ingest", &format!("step1 URL transcribe failed: {url_err}"));
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
            crate::logging::info(
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
                    crate::logging::info(
                        "ingest",
                        &format!("step2 local transcribe ok len={}", text.chars().count()),
                    );
                    return Ok(text);
                }
                Ok(_) => {
                    crate::logging::warn("ingest", "step2 local transcribe empty");
                    on_stage("音频流转写结果为空，尝试下载视频提取音轨");
                }
                Err(err) => {
                    crate::logging::error("ingest", &format!("step2 local transcribe failed: {err}"));
                    on_stage(&format!("音频流转写失败：{err}，尝试下载视频提取音轨"));
                }
            }
        }
        Err(audio_err) => {
            crate::logging::error("ingest", &format!("step2 audio download failed: {audio_err}"));
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
fn transcribe_from_combined_video(
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

/// Persistent combined-video destination for the audio-extraction fallback.
fn combined_tmp_path(media_dir: &Path, bvid: &str, cid: i64) -> PathBuf {
    media_dir.join(format!("{bvid}_{cid}_comb.mp4"))
}

/// Extract the audio track from a local video file via ffmpeg, producing a
/// 16k mono WAV that DashScope accepts. Returns the output path.
fn extract_audio_with_ffmpeg(
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



fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_string()
}

// ---------------------------------------------------------------------------
// Document management + search + QA commands
// ---------------------------------------------------------------------------

/// Delete one ingested document (vectors + metadata row together).
#[tauri::command]
pub fn delete_document(doc_id: String, db: State<'_, Db>) -> Result<usize, String> {
    let doc_id = doc_id.trim().to_string();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    let removed = vectors::delete_doc_conn(&tx, &doc_id)?;
    tx.execute("DELETE FROM documents WHERE doc_id = ?1", params![doc_id])
        .map_err(|err| format!("failed to delete document row: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))?;
    Ok(removed)
}

/// List every ingested document, newest first.
#[tauri::command]
pub fn list_documents(db: State<'_, Db>) -> Result<Vec<DocumentRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT doc_id, bvid, page_index, video_title, page_title, source, status, error,
                    chunk_count, char_count, embed_model, embed_dim, updated_at,
                    source_type, file_path
             FROM documents ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("failed to list documents: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            // Column order above differs from row_to_document's expectation;
            // map explicitly here.
            let doc_id: String = row.get(0)?;
            let bvid: String = row.get(1)?;
            let page_index: i64 = row.get(2)?;
            // File documents (source_type = 'file') have no B站 identity —
            // their bvid column is empty and a watch URL would be bogus.
            let source_type: String = row.get(13)?;
            let file_path: String = row.get(14)?;
            let url = if bvid.is_empty() {
                String::new()
            } else {
                page_url(&bvid, page_index)
            };
            Ok(DocumentRow {
                url,
                doc_id,
                bvid,
                page_index,
                video_title: row.get(3)?,
                page_title: row.get(4)?,
                source: row.get(5)?,
                status: row.get(6)?,
                error: row.get(7)?,
                chunk_count: row.get(8)?,
                char_count: row.get(9)?,
                embed_model: row.get(10)?,
                embed_dim: row.get(11)?,
                updated_at: row.get(12)?,
                source_type,
                file_path,
            })
        })
        .map_err(|err| format!("failed to query documents: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read documents: {err}"))
}

/// One search hit with its document metadata attached.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    pub doc_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub score: f32,
    pub bvid: String,
    pub page_index: i64,
    pub video_title: String,
    pub page_title: String,
    pub url: String,
}

/// Attach document metadata to raw vector hits; misses degrade to blanks.
pub(crate) fn join_metadata(
    conn: &rusqlite::Connection,
    hits: Vec<SearchHit>,
) -> Result<Vec<KnowledgeHit>, String> {
    let doc_ids: Vec<String> = hits.iter().map(|hit| hit.doc_id.clone()).collect();
    let mut meta: HashMap<String, (String, i64, String, String)> = HashMap::new();
    for doc_id in &doc_ids {
        if meta.contains_key(doc_id) {
            continue;
        }
        let row = conn
            .query_row(
                "SELECT bvid, page_index, video_title, page_title FROM documents WHERE doc_id = ?1",
                params![doc_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .ok();
        if let Some((bvid, page_index, video_title, page_title)) = row {
            meta.insert(
                doc_id.clone(),
                (bvid, page_index, video_title, page_title),
            );
        }
    }
    Ok(hits
        .into_iter()
        .map(|hit| {
            let (bvid, page_index, video_title, page_title) = meta
                .get(&hit.doc_id)
                .cloned()
                .unwrap_or_default();
            let url = if bvid.is_empty() {
                String::new()
            } else {
                page_url(&bvid, page_index)
            };
            KnowledgeHit {
                doc_id: hit.doc_id,
                chunk_index: hit.chunk_index,
                content: hit.content,
                score: hit.score,
                bvid,
                page_index,
                video_title,
                page_title,
                url,
            }
        })
        .collect())
}

/// Semantic workspace search: query → embedding → cosine top-k + metadata.
#[tauri::command]
pub async fn search_knowledge(
    app: AppHandle,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<KnowledgeHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("请输入查询内容".to_string());
    }
    let client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        embed_client_from_conn(&conn)?
    };

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        let vector = client.embed_query(&query)?;
        let top_k = top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 50);
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let hits = vectors::search_conn(&conn, &vector, top_k, None)?;
        join_metadata(&conn, hits)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_id_and_url_shapes_are_stable() {
        assert_eq!(doc_id_of("BV1AbCdEfGhI", 2), "BV1AbCdEfGhI:p2");
        assert_eq!(
            page_url("BV1AbCdEfGhI", 3),
            "https://www.bilibili.com/video/BV1AbCdEfGhI?p=3"
        );
    }

    #[test]
    fn first_line_extracts_head_of_multiline_errors() {
        assert_eq!(first_line("第一行\n第二行"), "第一行");
        assert_eq!(first_line(""), "");
    }
}
