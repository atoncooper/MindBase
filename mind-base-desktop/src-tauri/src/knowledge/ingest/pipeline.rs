//! 视频入库编排：IPC 命令入口、逐分P 循环与向量/文档行的事务落库。

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::infra::db::Db;
use crate::knowledge::bilibili::content as bili_content;
use crate::knowledge::bilibili::require_session;
use crate::knowledge::vectors;
use crate::llm::embeddings::{embed_client_from_conn, EmbedClient};
use crate::media::asr::AsrClient;

use super::audio::media_dir_of;
use super::documents::{doc_id_of, mark_document_done, mark_document_failed, upsert_document_status};
use super::pages::{ingest_one_page, PageIdentity};
use super::{emit, IngestEvent};

/// Pause between pages — the backend's B站-friendliness pacing.
const PAGE_PACING: Duration = Duration::from_millis(500);

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
        Local { cfg: crate::infra::config::LocalAsrConfig, data_dir: PathBuf },
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
        let cfg = crate::infra::config::load(&conn)?;
        crate::infra::logging::info(
            "ingest",
            &format!(
                "[diag] local_asr.enabled={} port={} model={}",
                cfg.local_asr.enabled,
                cfg.local_asr.port,
                cfg.local_asr.model,
            ),
        );
        let ffmpeg_path =
            crate::media::ffmpeg::resolve_ffmpeg_path(&app, cfg.ffmpeg_path_override.as_deref()).ok();
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
            match crate::media::asr::resolve_api_key(&conn) {
                Ok(key) => AsrTarget::Cloud {
                    key,
                    base: crate::media::asr::resolve_base_url(&conn)?,
                    model: crate::media::asr::resolve_model(&conn)?,
                },
                Err(_) => {
                    crate::infra::logging::warn(
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
                crate::media::whisper_server::ensure_running(&spawn_cfg, &spawn_dir)
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
    let agent = crate::knowledge::bilibili::build_agent()?;

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

    // Enforce the media-cache LRU quota after the run. The downloaded
    // audio/video + WAV are kept for inspection but must not grow without
    // bound; a cleanup failure must never fail the ingestion itself, so the
    // quota degrades to the built-in default when config is unreadable.
    let quota_bytes = match db.conn.lock() {
        Ok(conn) => crate::infra::config::load(&conn)
            .map(|cfg| u64::from(cfg.media_cache_max_mb) * 1024 * 1024)
            .unwrap_or(crate::media::media_cache::DEFAULT_FALLBACK_QUOTA_BYTES),
        Err(_) => crate::media::media_cache::DEFAULT_FALLBACK_QUOTA_BYTES,
    };
    match crate::media::media_cache::evict_to_quota(&media_dir, quota_bytes) {
        Ok(report) if report.removed_files > 0 => crate::infra::logging::info(
            "ingest",
            &format!(
                "media cache evicted files={} freed_bytes={}",
                report.removed_files, report.freed_bytes
            ),
        ),
        Ok(_) => {}
        Err(err) => crate::infra::logging::warn("ingest", &format!("media cache eviction failed: {err}")),
    }

    emit(&IngestEvent::Done { ok, failed }, channel);
    Ok(IngestSummary { ok, failed })
}
