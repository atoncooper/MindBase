//! 本地文件入库编排：IPC 命令入口、逐文件循环与向量/文档行的事务落库。

use std::path::{Path, PathBuf};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::infra::db::Db;
use crate::knowledge::chunker;
use crate::knowledge::vectors;
use crate::llm::embeddings::{embed_client_from_conn, EmbedClient};

use super::documents::{
    check_duplicate, file_doc_id, hash_file, mark_file_done, upsert_file_status, DupCheck,
};
use super::extract::extract_text;
use super::ocr::{is_scanned_pdf_error, ocr_extract, OcrStatus};
use super::scan::{scan_selection, ScannedFile, ALLOWED_EXT, IMAGE_EXT};
use super::types::{FileIngestEvent, FileIngestSummary};

// ---------------------------------------------------------------------------
// Ingestion command
// ---------------------------------------------------------------------------

fn emit(event: &FileIngestEvent, channel: &Channel<FileIngestEvent>) {
    // A closed channel (window navigated away) must never abort ingestion.
    let _ = channel.send(event.clone());
}

/// Ingest local files/folders into the local knowledge base.
#[tauri::command]
pub async fn ingest_files(
    app: AppHandle,
    paths: Vec<String>,
    on_event: Channel<FileIngestEvent>,
) -> Result<FileIngestSummary, String> {
    let trimmed: Vec<String> = paths
        .iter()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .collect();
    if trimmed.is_empty() {
        return Err("未选择任何文件或文件夹".to_string());
    }
    let files = scan_selection(&trimmed);
    if files.is_empty() {
        return Err(format!(
            "所选位置没有可入库的文件（支持 {}）",
            ALLOWED_EXT.join(" / ")
        ));
    }

    // Credentials must be prechecked before any state changes — mirrors
    // `ingest_video`, which also refuses to start without an embedder.
    let embed_client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        embed_client_from_conn(&conn)?
    };

    // First-run dependency provisioning (embedded Python + pymupdf /
    // python-docx / readability-lxml) can take minutes — keep it off the
    // async runtime and off the database mutex.
    let (need_pdf, need_docx, need_readability) = files.iter().fold(
        (false, false, false),
        |(pdf, docx, readability), file| {
            (
                pdf || file.ext == "pdf",
                docx || file.ext == "docx",
                readability || file.ext == "html" || file.ext == "htm",
            )
        },
    );
    let data_dir = {
        let db = app.state::<Db>();
        db.data_dir
            .lock()
            .map(|dir| dir.clone())
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };
    let data_dir_for_doc = data_dir.clone();
    let python_exe = tauri::async_runtime::spawn_blocking(move || {
        crate::infra::python_runtime::ensure_doc_extract_python(
            &data_dir_for_doc,
            need_pdf,
            need_docx,
            need_readability,
        )
    })
    .await
    .map_err(|err| format!("解析环境准备任务失败：{err}"))??;

    // Local OCR state for this run: images always OCR, scanned PDFs fall
    // back to it. Provisioning (embedded Python + rapidocr) happens only
    // when local OCR is enabled and the batch can actually use it. The DB
    // lock is read in a scoped block and released before any await.
    let ocr = {
        let (ocr_cfg, any_image, any_pdf) = {
            let db = app.state::<Db>();
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            let config = crate::infra::config::load(&conn)?;
            (
                config.local_ocr.clone(),
                files.iter().any(|file| IMAGE_EXT.contains(&file.ext.as_str())),
                files.iter().any(|file| file.ext == "pdf"),
            )
        };
        if !ocr_cfg.enabled || (!any_image && !any_pdf) {
            OcrStatus::Disabled
        } else if crate::media::ocr_server::resolve_model_dir(&data_dir, &ocr_cfg.model).is_none() {
            OcrStatus::NoModel { model: ocr_cfg.model.clone() }
        } else {
            let data_dir2 = data_dir.clone();
            let device = ocr_cfg.device.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                crate::infra::python_runtime::ensure_ocr_python(&data_dir2, any_pdf, &device)
            })
            .await
            .map_err(|err| format!("OCR 环境准备任务失败：{err}"))?
            {
                Ok(exe) => OcrStatus::Ready {
                    exe,
                    model_dir: crate::media::ocr_server::resolve_model_dir(
                        &data_dir,
                        &ocr_cfg.model,
                    )
                    .unwrap_or_default(),
                    device: ocr_cfg.device,
                },
                Err(err) => OcrStatus::Failed(err),
            }
        }
    };

    // `State` borrows the app; the blocking worker re-resolves it from a
    // cloned handle instead of moving the borrow into a 'static closure.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        run_file_ingestion(&files, &python_exe, &embed_client, &ocr, &on_event, &db)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

fn run_file_ingestion(
    files: &[ScannedFile],
    python_exe: &Path,
    embed_client: &EmbedClient,
    ocr: &OcrStatus,
    channel: &Channel<FileIngestEvent>,
    db: &State<'_, Db>,
) -> Result<FileIngestSummary, String> {
    emit(
        &FileIngestEvent::Start { total: files.len() },
        channel,
    );

    let mut ok = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    for (position, file) in files.iter().enumerate() {
        let index = position as i64;
        let path = PathBuf::from(&file.path);
        let doc_id = file_doc_id(&path);
        emit(
            &FileIngestEvent::FileStart {
                index,
                file_name: file.name.clone(),
            },
            channel,
        );

        // Content hash + dedup verdict up front: a skip must not consume
        // embedding quota, so it happens before any row write or parsing.
        let content_hash = match hash_file(&path) {
            Ok(hash) => hash,
            Err(error) => {
                mark_failed(db, &doc_id, &file, &error)?;
                emit(&FileIngestEvent::FileFailed { index, error }, channel);
                failed += 1;
                continue;
            }
        };
        {
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            match check_duplicate(&conn, &doc_id, &content_hash)? {
                DupCheck::Unchanged { doc_id } => {
                    emit(
                        &FileIngestEvent::FileSkipped {
                            index,
                            doc_id,
                            reason: "内容未变化，无需重复入库".to_string(),
                        },
                        channel,
                    );
                    skipped += 1;
                    continue;
                }
                DupCheck::Duplicate { doc_id, title } => {
                    emit(
                        &FileIngestEvent::FileSkipped {
                            index,
                            doc_id,
                            reason: format!("与已入库文档「{title}」内容重复"),
                        },
                        channel,
                    );
                    skipped += 1;
                    continue;
                }
                DupCheck::Unique => {}
            }
        }

        // Mark processing first so the UI reflects in-flight state.
        {
            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            upsert_file_status(
                &conn,
                &doc_id,
                &file.path,
                &file.name,
                &file.name,
                &file.ext,
                "processing",
                "",
                &content_hash,
            )?;
        }

        match ingest_one_file(&path, file, python_exe, embed_client, ocr, index, channel) {
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
                let embed_dim = outcome
                    .chunks
                    .first()
                    .map(|chunk| chunk.embedding.len() as i64)
                    .unwrap_or(0);
                mark_file_done(
                    &tx,
                    &doc_id,
                    &file.ext,
                    outcome.chunks.len(),
                    outcome.char_count,
                    embed_client.model_name(),
                    embed_dim,
                    &content_hash,
                )?;
                tx.commit()
                    .map_err(|err| format!("failed to commit ingestion: {err}"))?;
                emit(
                    &FileIngestEvent::FileDone {
                        index,
                        doc_id,
                        chunks: outcome.chunks.len(),
                        chars: outcome.char_count,
                    },
                    channel,
                );
                ok += 1;
            }
            Err(error) => {
                mark_failed(db, &doc_id, file, &error)?;
                emit(&FileIngestEvent::FileFailed { index, error }, channel);
                failed += 1;
            }
        }
    }
    emit(&FileIngestEvent::Done { ok, failed, skipped }, channel);
    Ok(FileIngestSummary { ok, failed, skipped })
}

/// Persist one file's failure onto its documents row (short lock). The
/// upsert creates the row when the failure happened before any state was
/// written (e.g. the content hash could not be computed).
fn mark_failed(db: &State<'_, Db>, doc_id: &str, file: &ScannedFile, error: &str) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    upsert_file_status(
        &conn,
        doc_id,
        &file.path,
        &file.name,
        &file.name,
        &file.ext,
        "failed",
        error,
        "",
    )?;
    Ok(())
}

/// Per-file produced chunks, mirroring `ingest.rs`'s PageOutcome.
struct FileOutcome {
    chunks: Vec<vectors::UpsertChunk>,
    char_count: usize,
}

fn ingest_one_file(
    path: &Path,
    file: &ScannedFile,
    python_exe: &Path,
    embed_client: &EmbedClient,
    ocr: &OcrStatus,
    index: i64,
    channel: &Channel<FileIngestEvent>,
) -> Result<FileOutcome, String> {
    emit(
        &FileIngestEvent::FileStep {
            index,
            step: "parse".to_string(),
        },
        channel,
    );
    crate::infra::logging::info(
        "file_ingest",
        &format!("parse start path={} ext={}", file.path, file.ext),
    );
    let extracted = if IMAGE_EXT.contains(&file.ext.as_str()) {
        // Images have no text layer to parse — OCR is the only path.
        match ocr {
            OcrStatus::Ready { exe, model_dir, device } => {
                emit(
                    &FileIngestEvent::FileStep {
                        index,
                        step: "ocr".to_string(),
                    },
                    channel,
                );
                crate::infra::logging::info(
                    "file_ingest",
                    &format!("ocr start (image) path={}", file.path),
                );
                ocr_extract((exe, model_dir, device), path)?
            }
            other => return Err(other.unavailable_reason(true)),
        }
    } else {
        match extract_text(python_exe, path) {
            Ok(extracted) => extracted,
            Err(error) if file.ext == "pdf" && is_scanned_pdf_error(&error) => {
                // Scanned PDF: no text layer — try the local OCR fallback.
                match ocr {
                    OcrStatus::Ready { exe, model_dir, device } => {
                        emit(
                            &FileIngestEvent::FileStep {
                                index,
                                step: "ocr".to_string(),
                            },
                            channel,
                        );
                        crate::infra::logging::info(
                            "file_ingest",
                            &format!("ocr fallback (scanned pdf) path={}", file.path),
                        );
                        ocr_extract((exe, model_dir, device), path)?
                    }
                    other => return Err(other.unavailable_reason(false)),
                }
            }
            Err(error) => return Err(error),
        }
    };
    if extracted.text.trim().is_empty() {
        return Err("未提取到任何文本内容".to_string());
    }
    crate::infra::logging::info(
        "file_ingest",
        &format!(
            "parse ok path={} chars={}",
            file.path,
            extracted.text.chars().count()
        ),
    );

    emit(
        &FileIngestEvent::FileStep {
            index,
            step: "chunk".to_string(),
        },
        channel,
    );
    // The extracted title (PDF metadata / first heading / <title>) heads the
    // document; the file name is the section-level title for the embedding
    // header. Files have no outline — pass an empty slice.
    let title = if extracted.title.trim().is_empty() {
        file.name.clone()
    } else {
        extracted.title.trim().to_string()
    };
    let chunk_results = chunker::chunk_text(&extracted.text, &title, Some(&file.name), &[]);
    if chunk_results.is_empty() {
        return Err("正文为空，无法入库".to_string());
    }
    let char_count = extracted.text.chars().count();

    emit(
        &FileIngestEvent::FileStep {
            index,
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

    Ok(FileOutcome {
        chunks,
        char_count,
    })
}
