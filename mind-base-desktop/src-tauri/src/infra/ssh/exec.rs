//! 一次性远程执行：连接 → 认证 → exec 命令 → 收集输出（同步包装供工具层使用）。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::{ChannelMsg, Disconnect};

use super::client::{append_capped, connect_authenticated};
use super::types::{SshExecResult, INACTIVITY_TIMEOUT_SECS, MAX_TIMEOUT_SECS, MIN_TIMEOUT_SECS};
use super::SshHostConfig;

/// 超时参数夹取到 [1, 600] 秒。
pub fn clamp_timeout(timeout_secs: u64) -> u64 {
    timeout_secs.clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
}

/// 建立连接、认证并执行一条命令（不含外层超时，由 exec 统一包裹）。
async fn connect_and_run(
    host: &SshHostConfig,
    command: &str,
    fingerprint: Arc<Mutex<Option<String>>>,
) -> Result<SshExecResult, String> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(INACTIVITY_TIMEOUT_SECS)),
        ..Default::default()
    };
    let session = connect_authenticated(host, fingerprint, config).await?;

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|err| format!("SSH 打开会话通道失败：{err}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|err| format!("SSH 下发命令失败：{err}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_code = None;

    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                append_capped(&mut stdout, data.as_ref(), &mut stdout_truncated)
            }
            ChannelMsg::ExtendedData { data, .. } => {
                append_capped(&mut stderr, data.as_ref(), &mut stderr_truncated)
            }
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                let note = format!("\n[远端进程被信号终止：{signal_name:?} {error_message}]");
                append_capped(&mut stderr, note.as_bytes(), &mut stderr_truncated);
            }
            _ => {}
        }
    }

    let _ = session.disconnect(Disconnect::ByApplication, "", "zh-CN").await;

    let mut stdout = String::from_utf8_lossy(&stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&stderr).into_owned();
    if stdout_truncated {
        stdout.push_str("\n[输出超过 1MB，已截断]");
    }
    if stderr_truncated {
        stderr.push_str("\n[输出超过 1MB，已截断]");
    }
    Ok(SshExecResult {
        stdout,
        stderr,
        exit_code,
        fingerprint: String::new(),
        duration_ms: 0,
    })
}

/// 异步执行一条远程命令（连接 + 认证 + exec，整体受 timeout 约束）。
pub async fn exec(
    host: &SshHostConfig,
    command: &str,
    timeout_secs: u64,
) -> Result<SshExecResult, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("远程命令不能为空".to_string());
    }
    let timeout_secs = clamp_timeout(timeout_secs);
    let host_label = format!("{}@{}:{}", host.username, host.host, host.port);
    let fingerprint = Arc::new(Mutex::new(None::<String>));
    let started = Instant::now();

    let outcome = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        connect_and_run(host, command, fingerprint.clone()),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let fingerprint = fingerprint
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_default();

    match outcome {
        Err(_) => Err(format!(
            "SSH 执行超时（{host_label}，{timeout_secs}s）：命令已中止；可调大 timeout_secs 或检查网络/远端负载"
        )),
        Ok(Err(err)) => Err(err),
        Ok(Ok(mut result)) => {
            result.duration_ms = duration_ms;
            result.fingerprint = fingerprint;
            Ok(result)
        }
    }
}

/// 同步包装：内部创建 current-thread runtime 执行 exec，供同步 LocalTool 使用。
pub fn exec_blocking(
    host: &SshHostConfig,
    command: &str,
    timeout_secs: u64,
) -> Result<SshExecResult, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("创建 SSH 运行时失败：{err}"))?;
    runtime.block_on(exec(host, command, timeout_secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::MAX_CAPTURE_BYTES;

    #[test]
    fn timeout_is_clamped_to_safe_range() {
        assert_eq!(clamp_timeout(0), 1);
        assert_eq!(clamp_timeout(1), 1);
        assert_eq!(clamp_timeout(120), 120);
        assert_eq!(clamp_timeout(9999), MAX_TIMEOUT_SECS);
    }

    #[test]
    fn output_capture_is_capped_and_flagged() {
        let mut buffer = Vec::new();
        let mut truncated = false;
        append_capped(&mut buffer, b"hello", &mut truncated);
        assert_eq!(buffer, b"hello");
        assert!(!truncated);

        let mut big = Vec::new();
        let mut big_truncated = false;
        let chunk = vec![b'x'; MAX_CAPTURE_BYTES];
        append_capped(&mut big, &chunk, &mut big_truncated);
        append_capped(&mut big, b"tail", &mut big_truncated);
        assert_eq!(big.len(), MAX_CAPTURE_BYTES);
        assert!(big_truncated);
    }

    #[test]
    fn exec_rejects_empty_command_before_connecting() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let host = SshHostConfig::default();
        let err = runtime
            .block_on(exec(&host, "   ", 5))
            .expect_err("empty command must be rejected");
        assert!(err.contains("不能为空"), "{err}");
    }
}
