//! Local file ingestion: files/folders on disk → text extraction (Python
//! sidecar `scripts/doc_extract.py`) → chunk → embed → the built-in vector
//! store, mirroring `ingest.rs`'s video pipeline.
//!
//! Documents get `doc_id = "file:" + md5(abs path)` so re-ingesting the same
//! path replaces its chunks idempotently (same upsert semantics as videos);
//! the `documents` row stores `source_type = 'file'` and the absolute path.
//! Like the video pipeline, v1 is deliberately single-flight — the frontend
//! keeps the start button busy — and one bad file never blocks the rest.

use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::chunker;
use crate::db::Db;
use crate::embeddings::{embed_client_from_conn, EmbedClient};
use crate::vectors;

/// Extensions accepted for ingestion (lowercase, without the dot).
const ALLOWED_EXT: &[&str] = &["txt", "md", "markdown", "pdf", "docx", "html", "htm"];
/// Per-file size cap — a bigger file is almost certainly data, not prose.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Batch cap so a folder pick can't enqueue the whole disk.
const MAX_FILES: usize = 500;
/// Recursion cap for folder scans (defensive; a doc tree is never this deep).
const MAX_SCAN_DEPTH: usize = 12;

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/// One progress update pushed to the frontend during file ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileIngestEvent {
    Start { total: usize },
    FileStart { index: i64, file_name: String },
    /// `step`: parse | chunk | embed | store.
    FileStep { index: i64, step: String },
    FileDone {
        index: i64,
        doc_id: String,
        chunks: usize,
        chars: usize,
    },
    FileFailed { index: i64, error: String },
    /// File skipped by the content-hash dedup (already ingested, unchanged
    /// content or a byte-identical copy under another name/path).
    FileSkipped { index: i64, doc_id: String, reason: String },
    Done {
        ok: usize,
        failed: usize,
        skipped: usize,
    },
}

fn emit(event: &FileIngestEvent, channel: &Channel<FileIngestEvent>) {
    // A closed channel (window navigated away) must never abort ingestion.
    let _ = channel.send(event.clone());
}

// ---------------------------------------------------------------------------
// Path scanning
// ---------------------------------------------------------------------------

/// One file the backend would ingest, as shown in the import-page list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub ext: String,
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_allowed(ext: &str) -> bool {
    ALLOWED_EXT.contains(&ext)
}

/// Recursively collect ingestible files from one user-picked path.
fn scan_one(path: &Path, depth: usize, out: &mut Vec<ScannedFile>) {
    if out.len() >= MAX_FILES || depth > MAX_SCAN_DEPTH {
        return;
    }
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return, // vanished between pick and scan — skip silently
    };
    if meta.is_file() {
        let ext = ext_of(path);
        if !is_allowed(&ext) || meta.len() > MAX_FILE_BYTES {
            return;
        }
        out.push(ScannedFile {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            size: meta.len(),
            ext,
        });
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    children.sort(); // deterministic order for a stable progress narrative
    for child in children {
        let hidden = child
            .file_name()
            .map(|name| name.to_string_lossy().starts_with('.'))
            .unwrap_or(false);
        if !hidden {
            scan_one(&child, depth + 1, out);
        }
    }
}

/// Collect ingestible files from a user selection (files and/or folders).
fn scan_selection(paths: &[String]) -> Vec<ScannedFile> {
    let mut files = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        let mut found = Vec::new();
        scan_one(&path, 0, &mut found);
        for file in found {
            // The same file can be reached twice when the user picks both a
            // folder and a file inside it (or nested folders overlap).
            if seen.insert(file.path.clone()) {
                files.push(file);
            }
        }
    }
    files.truncate(MAX_FILES);
    files
}

/// Pre-scan a selection so the UI can show exactly what a folder expands to
/// before anything is ingested.
#[tauri::command]
pub fn scan_import_paths(paths: Vec<String>) -> Result<Vec<ScannedFile>, String> {
    let trimmed: Vec<String> = paths
        .iter()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .collect();
    if trimmed.is_empty() {
        return Err("未选择任何文件或文件夹".to_string());
    }
    let mut any_exists = false;
    for raw in &trimmed {
        if Path::new(raw).exists() {
            any_exists = true;
            break;
        }
    }
    if !any_exists {
        return Err("所选路径均不存在".to_string());
    }
    Ok(scan_selection(&trimmed))
}

// ---------------------------------------------------------------------------
// Document identity & rows
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// Canonical doc id for one local file. Windows paths are case-insensitive,
/// so the hash folds case — `C:\a.md` and `c:\A.MD` are the same document.
fn file_doc_id(path: &Path) -> String {
    use md5::{Digest, Md5};

    let key = path.to_string_lossy();
    #[cfg(windows)]
    let key = key.to_lowercase();
    let mut hasher = Md5::new();
    hasher.update(key.as_bytes());
    format!("file:{:x}", hasher.finalize())
}

/// Content digest of one file, streamed in chunks (files are capped at
/// [`MAX_FILE_BYTES`] by the scan, so this never blows memory). MD5 is fine
/// here: the threat is accidental duplication, not adversarial collision.
fn hash_file(path: &Path) -> Result<String, String> {
    use md5::{Digest, Md5};
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|err| format!("无法读取文件：{err}"))?;
    let mut hasher = Md5::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|err| format!("读取文件内容失败：{err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Verdict of the content-hash dedup check for one file.
#[derive(Debug)]
enum DupCheck {
    /// Nothing previously ingested matches — proceed.
    Unique,
    /// The very same doc is already done with identical content.
    Unchanged { doc_id: String },
    /// Byte-identical content lives under another document.
    Duplicate { doc_id: String, title: String },
}

/// Compare a file's content hash against done documents (the `documents` row
/// carries the hash of its *source file*, so this covers both re-picking the
/// same path and copying a file elsewhere / renaming it).
fn check_duplicate(
    conn: &rusqlite::Connection,
    doc_id: &str,
    content_hash: &str,
) -> Result<DupCheck, String> {
    if content_hash.is_empty() {
        return Ok(DupCheck::Unique);
    }
    let mut statement = conn
        .prepare(
            "SELECT doc_id, video_title FROM documents
             WHERE content_hash = ?1 AND status = 'done'",
        )
        .map_err(|err| format!("failed to query content hashes: {err}"))?;
    let rows = statement
        .query_map(params![content_hash], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("failed to query content hashes: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read content hashes: {err}"))?;
    if let Some((other_id, title)) = rows.iter().find(|(id, _)| id != doc_id) {
        return Ok(DupCheck::Duplicate {
            doc_id: other_id.clone(),
            title: title.clone(),
        });
    }
    if rows.iter().any(|(id, _)| id == doc_id) {
        return Ok(DupCheck::Unchanged {
            doc_id: doc_id.to_string(),
        });
    }
    Ok(DupCheck::Unique)
}

/// Insert-or-update a file document row while the file is in flight.
fn upsert_file_status(
    conn: &rusqlite::Connection,
    doc_id: &str,
    file_path: &str,
    title: &str,
    file_name: &str,
    ext: &str,
    status: &str,
    error: &str,
    content_hash: &str,
) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO documents(doc_id, bvid, cid, page_index, video_title, page_title,
                               upper_name, source, status, error, source_type, file_path,
                               content_hash, created_at, updated_at)
         VALUES(?1, '', 0, 1, ?2, ?3, '', ?4, ?5, ?6, 'file', ?7, ?8, ?9, ?9)
         ON CONFLICT(doc_id) DO UPDATE SET
             video_title = excluded.video_title,
             page_title = excluded.page_title,
             source = excluded.source,
             status = excluded.status,
             error = excluded.error,
             file_path = excluded.file_path,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at",
        params![doc_id, title, file_name, ext, status, error, file_path, content_hash, now],
    )
    .map_err(|err| format!("failed to update document status: {err}"))?;
    Ok(())
}

/// Finalize a file document row with its produced-content facts.
fn mark_file_done(
    conn: &rusqlite::Connection,
    doc_id: &str,
    ext: &str,
    chunk_count: usize,
    char_count: usize,
    embed_model: &str,
    embed_dim: i64,
    content_hash: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE documents
         SET status = 'done', error = '', source = ?2, chunk_count = ?3,
             char_count = ?4, embed_model = ?5, embed_dim = ?6, content_hash = ?7,
             updated_at = ?8
         WHERE doc_id = ?1",
        params![
            doc_id,
            ext,
            chunk_count as i64,
            char_count as i64,
            embed_model,
            embed_dim,
            content_hash,
            now_secs()
        ],
    )
    .map_err(|err| format!("failed to finalize document: {err}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Python-side text extraction
// ---------------------------------------------------------------------------

/// Text facts extracted from one file by `doc_extract.py`.
struct Extracted {
    title: String,
    text: String,
}

#[derive(Deserialize)]
struct ExtractPayload {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    error: String,
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

/// Run `doc_extract.py` on one file and parse its JSON verdict.
fn extract_text(exe: &Path, file: &Path) -> Result<Extracted, String> {
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    // The extractor prints exactly one JSON line on stdout, but libraries it
    // loads may emit warnings to stdout as well (pymupdf's `fitz` shim does)
    // — the verdict is therefore the LAST non-empty line, never the first.
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or("");
    let payload: ExtractPayload = serde_json::from_str(line).map_err(|err| {
        let snippet: String = line.chars().take(120).collect();
        format!("解析器输出无法读取：{err}（输出片段：{snippet}）")
    })?;
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

// ---------------------------------------------------------------------------
// Ingestion command
// ---------------------------------------------------------------------------

/// Outcome summary of one file-ingestion run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIngestSummary {
    pub ok: usize,
    pub failed: usize,
    /// Files skipped by the content-hash dedup.
    pub skipped: usize,
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
    let python_exe = tauri::async_runtime::spawn_blocking(move || {
        crate::python_runtime::ensure_doc_extract_python(
            &data_dir,
            need_pdf,
            need_docx,
            need_readability,
        )
    })
    .await
    .map_err(|err| format!("解析环境准备任务失败：{err}"))??;

    // `State` borrows the app; the blocking worker re-resolves it from a
    // cloned handle instead of moving the borrow into a 'static closure.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        run_file_ingestion(&files, &python_exe, &embed_client, &on_event, &db)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

fn run_file_ingestion(
    files: &[ScannedFile],
    python_exe: &Path,
    embed_client: &EmbedClient,
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

        match ingest_one_file(&path, file, python_exe, embed_client, index, channel) {
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
    crate::logging::info(
        "file_ingest",
        &format!("parse start path={} ext={}", file.path, file.ext),
    );
    let extracted = extract_text(python_exe, path)?;
    if extracted.text.trim().is_empty() {
        return Err("未提取到任何文本内容".to_string());
    }
    crate::logging::info(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_doc_id_is_stable_and_prefixed() {
        let path = Path::new("C:\\docs\\a.pdf");
        assert_eq!(file_doc_id(path), file_doc_id(Path::new("C:\\docs\\a.pdf")));
        assert!(file_doc_id(path).starts_with("file:"));
        assert_ne!(file_doc_id(Path::new("C:\\docs\\a.pdf")), file_doc_id(Path::new("C:\\docs\\b.pdf")));
    }

    #[test]
    fn ext_filter_matches_allow_list() {
        assert!(is_allowed("pdf"));
        // `ext_of` lowercases before filtering, so only lowercase reaches here.
        assert!(is_allowed("md"));
        assert!(!is_allowed("exe"));
        assert!(!is_allowed(""));
    }

    #[test]
    fn scan_selection_picks_files_and_folder_children() {
        let dir = std::env::temp_dir().join(format!("mb-scan-test-{}", std::process::id()));
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(sub.join("b.md"), "world").unwrap();
        std::fs::write(sub.join("skip.exe"), "nope").unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden").join("c.txt"), "nope").unwrap();

        let files = scan_selection(&[dir.to_string_lossy().to_string()]);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.md"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hash_file_is_stable_and_content_sensitive() {
        let dir = std::env::temp_dir().join(format!("mb-hash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        std::fs::write(&a, b"hello world").unwrap();
        let first = hash_file(&a).unwrap();
        assert_eq!(first, hash_file(&a).unwrap());
        std::fs::write(&a, b"hello worlds").unwrap();
        assert_ne!(first, hash_file(&a).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn check_duplicate_only_considers_done_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE documents(
                 doc_id TEXT PRIMARY KEY, video_title TEXT NOT NULL DEFAULT '',
                 status TEXT NOT NULL DEFAULT 'pending',
                 content_hash TEXT NOT NULL DEFAULT '');",
        )
        .unwrap();
        for (doc_id, status, hash) in [
            ("file:aaaa", "done", "HASH1"),
            ("file:bbbb", "failed", "HASH1"), // failed rows must not count
            ("file:cccc", "done", "HASH2"),
        ] {
            conn.execute(
                "INSERT INTO documents(doc_id, status, content_hash) VALUES(?1, ?2, ?3)",
                params![doc_id, status, hash],
            )
            .unwrap();
        }

        // Same content under a different document → duplicate of 《title》.
        match check_duplicate(&conn, "file:dddd", "HASH1").unwrap() {
            DupCheck::Duplicate { doc_id, .. } => assert_eq!(doc_id, "file:aaaa"),
            other => panic!("expected duplicate, got {other:?}"),
        }
        // The identical doc re-picked → unchanged.
        match check_duplicate(&conn, "file:aaaa", "HASH1").unwrap() {
            DupCheck::Unchanged { doc_id } => assert_eq!(doc_id, "file:aaaa"),
            other => panic!("expected unchanged, got {other:?}"),
        }
        // Unknown hash → unique.
        assert!(matches!(
            check_duplicate(&conn, "file:eeee", "HASH9").unwrap(),
            DupCheck::Unique
        ));
        // Empty hash → unique (row not yet hashed).
        assert!(matches!(
            check_duplicate(&conn, "file:ffff", "").unwrap(),
            DupCheck::Unique
        ));
    }
}
