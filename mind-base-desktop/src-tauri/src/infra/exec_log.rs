//! Execution output logs: command output is captured to files instead of
//! being passed through memory, then summarized as a head/tail preview.
//!
//! 命令（run_command / git / gh / run_sandboxed）的 stdout/stderr 直接重定向到
//! <data_dir>/logs/exec/ 下的文件；工具只回传「头 N + 尾 M 字节」摘要与文件路径。
//! 模型需要更多内容时，用 read_file 带 offset/limit 分段读取（字节偏移）。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 摘要里保留的头部字节数。
pub(crate) const PREVIEW_HEAD_BYTES: usize = 2 * 1024;
/// 摘要里保留的尾部字节数。
pub(crate) const PREVIEW_TAIL_BYTES: usize = 4 * 1024;
/// 日志目录保留的总字节上限（超过按 mtime 删旧）。
const LOG_DIR_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 日志目录保留的文件数上限。
const LOG_DIR_MAX_FILES: usize = 200;

/// 统一的执行日志目录：<data_dir>/logs/exec。
pub(crate) fn log_root(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("exec")
}

/// 为一次执行创建一对（stdout / stderr）日志文件路径，并清理由此产生的旧日志。
pub(crate) fn create_paths(dir: &Path, tag: &str) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(dir)
        .map_err(|err| format!("创建执行日志目录失败（{}）：{err}", dir.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_millis())
        .unwrap_or_default();
    let pid = std::process::id();
    let unique = UNIQUE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = format!("{stamp}-{pid}-{unique}-{tag}");
    Ok((
        dir.join(format!("{base}.out.log")),
        dir.join(format!("{base}.err.log")),
    ))
}

static UNIQUE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 读取一个日志文件的头部 + 尾部摘要（中间省略）。
pub(crate) fn summarize(path: &Path, total_bytes: u64) -> String {
    let path_text = path.display().to_string();
    if total_bytes == 0 {
        return format!("（空）\n完整输出：{path_text}");
    }
    let limit = (PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES) as u64;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) => return format!("（无法读取输出文件 {path_text}：{err}）"),
    };
    let head_bytes = read_exact_up_to(&mut file, PREVIEW_HEAD_BYTES as u64);
    let head = String::from_utf8_lossy(&head_bytes).into_owned();
    if total_bytes <= limit {
        return format!("{head}\n完整输出：{path_text}");
    }
    let tail_len = PREVIEW_TAIL_BYTES as u64;
    let tail = match total_bytes.checked_sub(tail_len) {
        Some(offset) if file.seek(SeekFrom::Start(offset)).is_ok() => {
            String::from_utf8_lossy(&read_exact_up_to(&mut file, tail_len)).into_owned()
        }
        _ => String::new(),
    };
    format!(
        "{head}\n…（中间省略 {} 字节，完整输出：{path_text}；用 read_file 的 offset/limit 分段读取）…\n{tail}",
        total_bytes.saturating_sub(limit)
    )
}

/// 从当前读取位置尽量读 `limit` 字节（可短读）。
fn read_exact_up_to<R: Read>(reader: &mut R, limit: u64) -> Vec<u8> {
    let mut collected: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8 * 1024];
    while (collected.len() as u64) < limit {
        let remaining = (limit - collected.len() as u64).min(buffer.len() as u64) as usize;
        match reader.read(&mut buffer[..remaining]) {
            Ok(0) | Err(_) => break,
            Ok(read) => collected.extend_from_slice(&buffer[..read]),
        }
    }
    collected
}
/// 读取日志文件的一个字节区间（供 read_file 的 offset/limit 使用）。
pub(crate) fn read_slice(
    path: &Path,
    offset: u64,
    limit: usize,
) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|err| format!("无法打开文件（{}）：{err}", path.display()))?;
    let total = file
        .metadata()
        .map_err(|err| format!("无法读取文件信息（{}）：{err}", path.display()))?
        .len();
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("定位失败（offset={offset}）：{err}"))?;
    }
    let remaining = total.saturating_sub(offset);
    let take = (limit as u64).min(remaining);
    let buffer = read_exact_up_to(&mut file, take);
    Ok((String::from_utf8_lossy(&buffer).into_owned(), total))
}

/// 清理过旧 / 过多的执行日志（按 mtime，从旧到新删除直到达标）。
pub(crate) fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_file() {
            files.push((
                metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                metadata.len(),
                entry.path(),
            ));
        }
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    let mut count = files.len();
    for (_, size, path) in files {
        if total <= LOG_DIR_MAX_BYTES && count <= LOG_DIR_MAX_FILES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            count = count.saturating_sub(1);
        }
    }
}

/// 写入一个日志文件（仅用于测试 / 简单场景）。
#[cfg(test)]
pub(crate) fn write_fixture(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::File::create(path)?;
    file.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_keeps_head_and_tail_for_large_output() {
        let dir = std::env::temp_dir().join(format!("mb-exec-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("big.log");
        let mut body = String::new();
        for index in 0..10_000 {
            body.push_str(&format!("line-{index}\n"));
        }
        write_fixture(&path, body.as_bytes()).expect("write");
        let summary = summarize(&path, body.len() as u64);
        assert!(summary.contains("line-0"), "head missing");
        assert!(summary.contains("line-9999"), "tail missing");
        assert!(summary.contains("中间省略"), "omission marker missing");
        assert!(summary.len() < PREVIEW_HEAD_BYTES + PREVIEW_TAIL_BYTES + 512);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_slice_pages_by_bytes() {
        let dir = std::env::temp_dir().join(format!("mb-exec-slice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("slice.log");
        write_fixture(&path, b"0123456789abcdef").expect("write");
        let (text, total) = read_slice(&path, 4, 6).expect("slice");
        assert_eq!(total, 16);
        assert_eq!(text, "456789");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn create_paths_are_unique_and_prune_keeps_budget() {
        let dir = std::env::temp_dir().join(format!("mb-exec-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let (first, _) = create_paths(&dir, "test").expect("paths");
        let (second, _) = create_paths(&dir, "test").expect("paths");
        assert_ne!(first, second);
        for index in 0..205 {
            write_fixture(&dir.join(format!("old-{index}.log")), b"x").expect("write");
        }
        prune(&dir);
        let remaining = std::fs::read_dir(&dir).expect("read").count();
        assert!(remaining <= LOG_DIR_MAX_FILES, "prune left {remaining} files");
        let _ = std::fs::remove_dir_all(dir);
    }
}
