//! 日志分区：按 任务 / 日期 / run 落盘，并提供尾部读取、区间读取、关键字检索。
//!
//! 目录示例：
//!   <data_dir>/automation/7/2026-10-28/2026-10-28T10-00-00_run-12.log
//!   <data_dir>/automation/7/2026-10-28/2026-10-28T10-00-00_run-12.err.log

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 任务根目录：<data_dir>/automation/<task_id>/
pub fn task_root(data_dir: &Path, task_id: i64) -> PathBuf {
    data_dir.join("automation").join(task_id.to_string())
}

/// 一次运行的 stdout / stderr 日志路径（按本地日期分区）。
pub fn run_log_paths(
    data_dir: &Path,
    task_id: i64,
    run_id: i64,
    epoch: i64,
) -> (PathBuf, PathBuf) {
    let (year, month, day, hour, minute, second) = ymd_hms(epoch);
    let dir = task_root(data_dir, task_id).join(format!("{year:04}-{month:02}-{day:02}"));
    let base = format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}_run-{run_id}"
    );
    (dir.join(format!("{base}.log")), dir.join(format!("{base}.err.log")))
}

pub fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建日志目录失败（{}）：{err}", parent.display()))?;
    }
    Ok(())
}

/// 读取文件尾部最多 max_bytes 字节（UTF-8 有损解码）。
pub fn read_tail(path: &Path, max_bytes: usize) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = size.saturating_sub(max_bytes as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 按字节区间读取（复用 exec_log 的分页实现）。
pub fn read_range(path: &Path, offset: u64, limit: usize) -> Result<(String, u64), String> {
    crate::infra::exec_log::read_slice(path, offset, limit)
}

#[derive(Debug, Clone)]
pub struct LogMatch {
    pub path: PathBuf,
    pub line_no: usize,
    pub line: String,
}

/// 在给定日志文件里按子串检索（大小写不敏感），最多返回 limit 条。
pub fn search_lines(paths: &[PathBuf], needle: &str, limit: usize) -> Result<Vec<LogMatch>, String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Err("query 不能为空".to_string());
    }
    let needle_lower = needle.to_lowercase();
    let mut matches = Vec::new();
    for path in paths {
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let Ok(line) = line else { break };
            if line.to_lowercase().contains(&needle_lower) {
                matches.push(LogMatch {
                    path: path.clone(),
                    line_no: index + 1,
                    line,
                });
                if matches.len() >= limit {
                    return Ok(matches);
                }
            }
        }
    }
    Ok(matches)
}

/// Unix 秒 -> (年, 月, 日, 时, 分, 秒)，UTC。
pub fn ymd_hms(epoch: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = epoch.div_euclid(86_400);
    let secs_of_day = epoch.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    (
        year,
        month,
        day,
        (secs_of_day / 3600) as u32,
        ((secs_of_day % 3600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
