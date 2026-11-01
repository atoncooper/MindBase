//! SSH 对外类型与常量：一次性执行结果、连通性报告、交互会话信息与事件载荷。

use serde::{Deserialize, Serialize};

/// 默认执行超时（秒）。
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
pub const MIN_TIMEOUT_SECS: u64 = 1;
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// 单次执行最多缓存的 stdout / stderr 字节数，防止远端刷屏吃掉内存。
pub(crate) const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
/// 连接 + 认证阶段由外层 timeout 统一约束；这里给 inactivity 一个更宽的上限。
pub(crate) const INACTIVITY_TIMEOUT_SECS: u64 = MAX_TIMEOUT_SECS + 60;

/// 交互会话建立（连接 + 认证 + PTY + shell）的总超时。
pub(crate) const SESSION_CONNECT_TIMEOUT_SECS: u64 = 20;
/// 长会话保活：每 30s 发一次 keepalive，连续 3 次无响应即断开。
pub(crate) const SESSION_KEEPALIVE_SECS: u64 = 30;
pub(crate) const SESSION_KEEPALIVE_MAX: usize = 3;
pub(crate) const PTY_TERM: &str = "xterm-256color";
pub(crate) const PTY_DEFAULT_COLS: u32 = 120;
pub(crate) const PTY_DEFAULT_ROWS: u32 = 32;

/// 一次远程执行的完整结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExecResult {
    pub stdout: String,
    pub stderr: String,
    /// 远端退出码；通道没回 ExitStatus 时为 None（例如被信号终止）。
    pub exit_code: Option<u32>,
    /// 服务器主机公钥的 SHA256 指纹（形如 SHA256:...），便于人工核对。
    pub fingerprint: String,
    pub duration_ms: u64,
}

/// ssh_host_test 的返回体（UI 直接展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestReport {
    pub ok: bool,
    pub message: String,
    pub fingerprint: String,
    pub latency_ms: u64,
}

/// 一个活跃的交互式 SSH 会话（前端「终端」tab 的会话信息）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub session_id: String,
    pub host_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Unix epoch 秒（与项目其它时间戳口径一致）。
    pub connected_at: i64,
    /// 会话日志路径（host.logSession 开启时有值，否则空串；只读返回给 UI）。
    pub log_path: String,
}

/// 「ssh-output」事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOutputPayload {
    pub session_id: String,
    pub data: String,
    /// stdout | stderr
    pub stream: String,
}

/// 「ssh-closed」事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshClosedPayload {
    pub session_id: String,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_payloads_serialize_camel_case() {
        let info = SshSessionInfo {
            session_id: "abc123".to_string(),
            host_name: "prod".to_string(),
            host: "10.0.0.1".to_string(),
            port: 2222,
            username: "deploy".to_string(),
            connected_at: 1_700_000_000,
            log_path: "/data/logs/ssh/prod-20231114-221320.log".to_string(),
        };
        let json = serde_json::to_string(&info).expect("serialize info");
        assert!(json.contains("\"sessionId\":\"abc123\""), "{json}");
        assert!(json.contains("\"hostName\":\"prod\""), "{json}");
        assert!(json.contains("\"connectedAt\":1700000000"), "{json}");
        assert!(json.contains("\"logPath\""), "{json}");
        assert!(!json.contains("session_id"), "{json}");

        let output = SshOutputPayload {
            session_id: "abc123".to_string(),
            data: "ls\r\n".to_string(),
            stream: "stdout".to_string(),
        };
        let json = serde_json::to_string(&output).expect("serialize output");
        assert!(json.contains("\"sessionId\":\"abc123\""), "{json}");
        assert!(json.contains("\"stream\":\"stdout\""), "{json}");
        assert!(json.contains("\"data\":\"ls\\r\\n\""), "{json}");

        let closed = SshClosedPayload {
            session_id: "abc123".to_string(),
            reason: "远端已关闭会话".to_string(),
        };
        let json = serde_json::to_string(&closed).expect("serialize closed");
        assert!(json.contains("\"sessionId\":\"abc123\""), "{json}");
        assert!(json.contains("\"reason\""), "{json}");
    }
}
