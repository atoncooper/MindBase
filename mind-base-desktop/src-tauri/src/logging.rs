//! Minimal file-backed logging for the desktop app.
//!
//! The GUI has no visible console, so the handful of `eprintln!` calls are
//! effectively invisible when the app runs as a packaged window. This module
//! writes leveled, timestamped lines to `<data_dir>/logs/mindbase.log` so
//! failures — especially the ASR pipeline, which has been hard to debug — can
//! be inspected on disk. Lines are also mirrored to stderr so `tauri dev` /
//! `cargo run` still shows them in a terminal.
//!
//! Pure `std`, no external dependencies. Times are UTC (epoch-civil conversion
//! by the classic Hinnant algorithm).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Log levels, ordered by severity.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

struct Logger {
    file: Option<Mutex<File>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Initialise the file logger under `<data_dir>/logs/mindbase.log`.
/// Idempotent — the first call wins. Never fails hard: a broken log file must
/// not break startup, so the logger degrades to stderr-only.
pub fn init(data_dir: &Path) {
    let _ = LOGGER.get_or_init(|| {
        let logs_dir = data_dir.join("logs");
        let file = std::fs::create_dir_all(&logs_dir)
            .ok()
            .and_then(|_| {
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(logs_dir.join("mindbase.log"))
                    .ok()
            });
        if file.is_none() {
            eprintln!("[logging] cannot open log file under {}", logs_dir.display());
        }
        Logger { file: file.map(Mutex::new) }
    });
}

fn format_ts() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_epoch(secs);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")
}

/// Write one leveled line to the log file (and stderr).
pub fn log_line(level: Level, module: &str, msg: &str) {
    let ts = format_ts();
    eprintln!("[{ts}] [{:<5}] [{module}] {msg}", level.as_str());
    if let Some(logger) = LOGGER.get() {
        if let Some(file) = &logger.file {
            if let Ok(mut f) = file.lock() {
                let line = format!("[{ts}] [{:<5}] [{module}] {msg}\n", level.as_str());
                let _ = f.write_all(line.as_bytes());
                let _ = f.flush();
            }
        }
    }
}

/// Convenience: INFO-level line.
pub fn info(module: &str, msg: &str) {
    log_line(Level::Info, module, msg);
}

/// Convenience: WARN-level line.
pub fn warn(module: &str, msg: &str) {
    log_line(Level::Warn, module, msg);
}

/// Convenience: ERROR-level line.
pub fn error(module: &str, msg: &str) {
    log_line(Level::Error, module, msg);
}

/// Classic Hinnant `civil_from_days`: convert days since epoch to (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn civil_from_epoch(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (
        y,
        m,
        d,
        (secs_of_day / 3600) as u32,
        ((secs_of_day % 3600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_civil_conversion_is_correct() {
        // 2024-01-01T00:00:00Z = 1704067200
        assert_eq!(civil_from_epoch(1_704_067_200), (2024, 1, 1, 0, 0, 0));
        // 2000-02-29T12:34:56Z = 951897296
        assert_eq!(civil_from_epoch(951_897_296), (2000, 2, 29, 12, 34, 56));
    }
}
