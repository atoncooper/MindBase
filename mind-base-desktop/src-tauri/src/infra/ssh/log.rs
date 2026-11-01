//! SSH 交互会话日志：把终端输出追加写入 data_dir/logs/ssh/<host>-<stamp>.log。
//!
//! 只记录输出（stdout/stderr 原始字节），不记录用户输入、密码或私钥。
//! 日志写入失败只警告一次，不影响读任务/终端交互。

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::infra::config::SshHostConfig;

/// 主机名清洗：仅保留 ASCII 字母数字与 . _ -，其余替换为 '-'，避免路径注入。
pub(super) fn sanitize_host_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "host".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 会话开始时间戳（UTC，yyyymmdd-HHMMSS，作为文件名的一部分）。
pub(super) fn session_stamp(now: i64) -> String {
    let days = now.div_euclid(86_400);
    let rem = now.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant civil_from_days（不引入 chrono）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 会话日志路径（纯函数，便于单测）。
pub(super) fn log_path(data_dir: &Path, host_name: &str, now: i64) -> PathBuf {
    data_dir
        .join("logs")
        .join("ssh")
        .join(format!("{}-{}.log", sanitize_host_name(host_name), session_stamp(now)))
}

/// 创建会话日志并写头（时间/主机/用户）；失败返回中文错误，调用方降级为不记录。
pub(super) fn open_session_log(
    data_dir: &Path,
    host: &SshHostConfig,
    now: i64,
) -> Result<(PathBuf, std::fs::File), String> {
    let path = log_path(data_dir, &host.name, now);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建 SSH 日志目录失败（{}）：{err}", parent.display()))?;
    }
    let mut file = std::fs::File::create(&path)
        .map_err(|err| format!("创建 SSH 会话日志失败（{}）：{err}", path.display()))?;
    // 头部写失败不算致命（文件仍可追加输出）。
    let _ = writeln!(file, "# MindBase SSH session log");
    let _ = writeln!(file, "# started(UTC): {}", session_stamp(now));
    let _ = writeln!(
        file,
        "# host: {} ({}@{}:{})",
        host.name, host.username, host.host, host.port
    );
    let _ = writeln!(
        file,
        "# note: 仅记录终端输出；不记录用户输入、密码或私钥"
    );
    Ok((path, file))
}

/// 追加一段原始输出；失败返回 io 错误（调用方只警告一次并继续）。
pub(super) fn append(file: &mut std::fs::File, data: &[u8]) -> std::io::Result<()> {
    file.write_all(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_are_sanitized_for_file_names() {
        assert_eq!(sanitize_host_name("prod-01"), "prod-01");
        assert_eq!(sanitize_host_name("a/b"), "a-b");
        assert_eq!(sanitize_host_name("../../etc/passwd"), "..-..-etc-passwd");
        assert_eq!(sanitize_host_name("   "), "host");
        assert!(sanitize_host_name("中文主机").chars().all(|ch| ch == '-' || ch.is_ascii()));
    }

    #[test]
    fn session_stamp_is_utc_and_stable() {
        assert_eq!(session_stamp(0), "19700101-000000");
        assert_eq!(session_stamp(1_700_000_000), "20231114-221320");
    }

    #[test]
    fn log_path_lives_under_data_logs_ssh() {
        let path = log_path(Path::new("/data"), "prod/01", 0);
        let expected = Path::new("/data")
            .join("logs")
            .join("ssh")
            .join("prod-01-19700101-000000.log");
        assert_eq!(path, expected);
    }
}
