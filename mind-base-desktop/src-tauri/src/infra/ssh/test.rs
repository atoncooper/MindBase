//! 连通性测试命令（ssh_host_test）：连接 + 认证 + echo ok，并执行指纹 TOFU 策略。

use std::time::Instant;

use tauri::State;

use crate::infra::db::Db;

use super::exec::exec_blocking;
use super::fingerprint::{check_fingerprint, remember_fingerprint, FingerprintVerdict};
use super::hosts::load_hosts;
use super::types::SshTestReport;
use super::SshHostConfig;

/// Tauri 命令：按名称测试一台已保存的服务器（连接 + 认证 + 执行 echo ok）。
///
/// 配置层错误（名称不存在 / 主机配置非法）返回 Err；连通性 / 认证 / 执行
/// 失败返回 Ok(ok=false)，由 UI 展示 message。SSH 是阻塞 IO，放到
/// spawn_blocking 里执行，避免卡住 Tauri 的异步运行时。指纹策略见
/// check_fingerprint：空=TOFU 自动信任并写回；不一致=ok=false 且 message
/// 固定包含「指纹不匹配」。
#[tauri::command]
pub async fn ssh_host_test(name: String, db: State<'_, Db>) -> Result<SshTestReport, String> {
    let wanted = name.trim().to_string();
    if wanted.is_empty() {
        return Err("主机名称不能为空".to_string());
    }
    let hosts = load_hosts(db.inner())?;
    let host = hosts
        .into_iter()
        .find(|host| host.name == wanted)
        .ok_or_else(|| {
            format!(
                "未找到名为 {wanted:?} 的远程服务器，请先在「系统设置 → 远程服务器」添加并保存"
            )
        })?;
    let host_name = host.name.clone();
    let stored_fingerprint = host.fingerprint.clone();
    let mut report = tauri::async_runtime::spawn_blocking(move || test_host(host))
        .await
        .map_err(|err| format!("SSH 测试任务执行失败：{err}"))?;
    if report.ok {
        match check_fingerprint(&stored_fingerprint, &report.fingerprint) {
            Ok(FingerprintVerdict::Matched) => {}
            Ok(FingerprintVerdict::TrustedNew) => {
                if report.fingerprint.is_empty() {
                    report.ok = false;
                    report.message =
                        "连接成功但未能获取主机指纹，已中止（无法固定主机身份）".to_string();
                } else {
                    let hint = match remember_fingerprint(db.inner(), &host_name, &report.fingerprint)
                    {
                        Ok(()) => String::new(),
                        Err(err) => format!("；但指纹写回配置失败：{err}（请重试）"),
                    };
                    report.message = format!(
                        "{}（首次连接，已信任主机指纹 {}）{}",
                        report.message, report.fingerprint, hint
                    );
                }
            }
            Err(err) => {
                report.ok = false;
                report.message = err;
            }
        }
    }
    Ok(report)
}

/// 同步执行一次连通性测试（在 spawn_blocking 线程里跑）。
fn test_host(host: SshHostConfig) -> SshTestReport {
    let started = Instant::now();
    match exec_blocking(&host, "echo ok", 20) {
        Ok(result) => {
            let ok = result.exit_code == Some(0) && result.stdout.contains("ok");
            let message = if ok {
                format!(
                    "连接成功：{}@{}:{}（{}ms）",
                    host.username,
                    host.host,
                    host.port,
                    started.elapsed().as_millis()
                )
            } else {
                format!(
                    "已连接并完成认证，但测试命令返回异常（exit={:?}）：{}",
                    result.exit_code,
                    result.stderr.trim()
                )
            };
            SshTestReport {
                ok,
                message,
                fingerprint: result.fingerprint,
                latency_ms: started.elapsed().as_millis() as u64,
            }
        }
        Err(err) => SshTestReport {
            ok: false,
            message: err,
            fingerprint: String::new(),
            latency_ms: started.elapsed().as_millis() as u64,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_report_serializes_camel_case() {
        let report = SshTestReport {
            ok: true,
            message: "连接成功".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            latency_ms: 12,
        };
        let json = serde_json::to_string(&report).expect("serialize");
        assert!(json.contains("\"latencyMs\""), "{json}");
        assert!(json.contains("\"fingerprint\""), "{json}");
    }
}
