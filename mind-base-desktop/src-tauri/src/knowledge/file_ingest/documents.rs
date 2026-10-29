//! file 文档身份与 documents 行读写：内容 hash、去重判定与状态流转。

use std::path::Path;

use rusqlite::params;

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
pub(super) fn file_doc_id(path: &Path) -> String {
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
pub(super) fn hash_file(path: &Path) -> Result<String, String> {
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
pub(super) enum DupCheck {
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
pub(super) fn check_duplicate(
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
pub(super) fn upsert_file_status(
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
pub(super) fn mark_file_done(
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
