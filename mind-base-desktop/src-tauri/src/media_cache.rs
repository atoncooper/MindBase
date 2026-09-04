//! LRU size-quota eviction for the persisted media cache.
//!
//! Downloaded audio/video and extracted WAVs are deliberately kept under the
//! app data dir (see `ingest.rs`) so failures can be inspected; this module
//! bounds their total size instead of letting them grow without limit.
//!
//! LRU key is the file mtime: every file is written once by an ingest run, so
//! "most recently used" is "most recently downloaded/extracted". Eviction runs
//! after each ingestion run (not on a timer) and deletes oldest-first until
//! the directory total fits the quota. Files touched within the grace window
//! are never deleted — a concurrent ingest run may still be uploading them.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Files modified within this window are treated as actively in use by a
/// concurrent ingest run and are skipped by eviction.
const ACTIVE_GRACE: Duration = Duration::from_secs(10 * 60);

/// Quota used when the stored config can't be read at eviction time (2 GiB,
/// matching [`crate::config::default_media_cache_max_mb`]).
pub const DEFAULT_FALLBACK_QUOTA_BYTES: u64 = 2048 * 1024 * 1024;

/// One eviction pass outcome, in bytes freed and files removed.
#[derive(Debug, Default)]
pub struct EvictionReport {
    pub freed_bytes: u64,
    pub removed_files: usize,
}

/// Enforce `max_bytes` on everything under `media_dir` (recursive, so the
/// extracted-WAV naming scheme can change without updating this module).
/// `max_bytes == 0` disables eviction entirely. Returns the eviction report;
/// individual deletion failures are logged and skipped, never propagated.
pub fn evict_to_quota(media_dir: &Path, max_bytes: u64) -> Result<EvictionReport, String> {
    let mut report = EvictionReport::default();
    if max_bytes == 0 {
        return Ok(report);
    }

    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut stack = vec![media_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // A missing media dir just means nothing was ingested yet.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                return Err(format!(
                    "无法读取媒体缓存目录 {}：{err}",
                    dir.display()
                ))
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    crate::logging::warn(
                        "media_cache",
                        &format!("skip unreadable entry in {}: {err}", dir.display()),
                    );
                    continue;
                }
            };
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(err) => {
                    crate::logging::warn(
                        "media_cache",
                        &format!("skip unreadable file {}: {err}", path.display()),
                    );
                    continue;
                }
            };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                files.push((path, meta.len(), meta.modified().unwrap_or(SystemTime::now())));
            }
        }
    }

    let total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    if total <= max_bytes {
        return Ok(report);
    }

    // Oldest first: evict least-recently-used until the total fits.
    files.sort_by_key(|(_, _, mtime)| *mtime);
    let cutoff = SystemTime::now()
        .checked_sub(ACTIVE_GRACE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut remaining = total;
    for (path, size, mtime) in files {
        if remaining <= max_bytes {
            break;
        }
        if mtime > cutoff {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                remaining = remaining.saturating_sub(size);
                report.freed_bytes += size;
                report.removed_files += 1;
                crate::logging::info(
                    "media_cache",
                    &format!("evicted path={} bytes={}", path.display(), size),
                );
            }
            Err(err) => {
                crate::logging::warn(
                    "media_cache",
                    &format!("failed to evict {}: {err}", path.display()),
                );
            }
        }
    }

    if report.removed_files > 0 {
        crate::logging::info(
            "media_cache",
            &format!(
                "quota={}MB total_before={}MB freed={}MB removed={} (still over quota: {})",
                max_bytes / (1024 * 1024),
                total / (1024 * 1024),
                report.freed_bytes / (1024 * 1024),
                report.removed_files,
                remaining > max_bytes,
            ),
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn write(path: &Path, len: usize, age_secs: u64) {
        std::fs::write(path, vec![0u8; len]).unwrap();
        let mtime = SystemTime::now() - Duration::from_secs(age_secs);
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime)).unwrap();
    }

    #[test]
    fn evicts_oldest_first_and_respects_grace() {
        let dir = std::env::temp_dir().join(format!("mb-media-lru-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        write(&dir.join("old.m4s"), 1000, 3600);
        // Within the 10-minute grace window: must survive even though
        // deleting it would be the only way to reach the quota.
        write(&dir.join("mid.m4s"), 1000, 120);
        write(&dir.join("young.m4s"), 1000, 0);

        let report = evict_to_quota(&dir, 1500).unwrap();
        assert_eq!(report.removed_files, 1);
        assert_eq!(report.freed_bytes, 1000);
        assert!(!dir.join("old.m4s").exists());
        assert!(dir.join("mid.m4s").exists());
        assert!(dir.join("young.m4s").exists());

        // Once the grace expires, a second pass evicts `mid` too.
        write(&dir.join("mid.m4s"), 1000, 3600);
        let report = evict_to_quota(&dir, 1500).unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(!dir.join("mid.m4s").exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn under_quota_is_noop_and_zero_disables() {
        let dir = std::env::temp_dir().join(format!("mb-media-noop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write(&dir.join("a.m4s"), 100, 3600);

        assert_eq!(evict_to_quota(&dir, 10_000).unwrap().removed_files, 0);
        assert!(dir.join("a.m4s").exists());

        // max_bytes == 0 disables eviction entirely.
        assert_eq!(evict_to_quota(&dir, 0).unwrap().removed_files, 0);
        assert!(dir.join("a.m4s").exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}