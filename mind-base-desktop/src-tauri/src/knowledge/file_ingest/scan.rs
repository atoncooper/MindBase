//! 路径扫描：扩展名/大小/深度过滤与用户选择的展开。

use std::path::{Path, PathBuf};

use serde::Serialize;

// ---------------------------------------------------------------------------
// Path scanning
// ---------------------------------------------------------------------------

/// Extensions accepted for ingestion (lowercase, without the dot). Images
/// are ingested through local OCR (`scripts/ocr_extract.py`); scanned PDFs
/// fall back to it when their text layer is empty.
pub(super) const ALLOWED_EXT: &[&str] = &[
    "txt", "md", "markdown", "pdf", "docx", "html", "htm", "jpg", "jpeg", "png", "bmp", "webp",
];
/// Extensions ingested purely through local OCR.
pub(super) const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp"];
/// Per-file size cap — a bigger file is almost certainly data, not prose.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Batch cap so a folder pick can't enqueue the whole disk.
const MAX_FILES: usize = 500;
/// Recursion cap for folder scans (defensive; a doc tree is never this deep).
const MAX_SCAN_DEPTH: usize = 12;

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
pub(super) fn scan_selection(paths: &[String]) -> Vec<ScannedFile> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_filter_matches_allow_list() {
        assert!(is_allowed("pdf"));
        // `ext_of` lowercases before filtering, so only lowercase reaches here.
        assert!(is_allowed("md"));
        // Images are OCR-ingestible.
        assert!(is_allowed("png"));
        assert!(is_allowed("jpeg"));
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
}
