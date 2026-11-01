//! 本地端口转发（local forward）：127.0.0.1:local_port -> SSH 隧道 -> remote_host:remote_port。
//!
//! 只做本地转发（remote forwarding / SOCKS 暂不支持，见架构文档 §12）。
//! 每条转发在注册表里保存 accept 循环的 AbortHandle；remove 或会话断开时 abort
//! 并释放监听端口。转发的每个 TCP 连接复用会话 Handle 打开 direct-tcpip channel，
//! 用 tokio::io::copy_bidirectional 双向拷贝。

// 命令由 Lead 在 app/commands.rs 注册；注册完成前 crate 内没有调用方，
// 临时抑制 dead_code 噪音（注册后此属性可删除）。
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::session::session_handle;

/// 一条本地转发（UI 展示与 remove 用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshForwardInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub created_at: i64,
}

struct ForwardEntry {
    info: SshForwardInfo,
    abort: tokio::task::AbortHandle,
}

/// 会话 -> 转发 id -> 条目。
#[derive(Default)]
struct ForwardRegistry {
    sessions: HashMap<String, HashMap<String, ForwardEntry>>,
}

impl ForwardRegistry {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    fn insert(&mut self, session_id: &str, entry: ForwardEntry) {
        self.sessions
            .entry(session_id.to_string())
            .or_default()
            .insert(entry.info.id.clone(), entry);
    }

    fn remove(&mut self, session_id: &str, forward_id: &str) -> Option<ForwardEntry> {
        let removed = self
            .sessions
            .get_mut(session_id)
            .and_then(|forwards| forwards.remove(forward_id));
        if self
            .sessions
            .get(session_id)
            .map(|forwards| forwards.is_empty())
            .unwrap_or(false)
        {
            self.sessions.remove(session_id);
        }
        removed
    }

    /// 返回会话内全部转发（按创建时间、id 稳定排序）。
    fn list(&self, session_id: &str) -> Vec<SshForwardInfo> {
        let mut infos: Vec<SshForwardInfo> = self
            .sessions
            .get(session_id)
            .map(|forwards| forwards.values().map(|entry| entry.info.clone()).collect())
            .unwrap_or_default();
        infos.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        infos
    }

    /// 会话断开：abort 全部 accept 循环并删除记录。
    fn cleanup_session(&mut self, session_id: &str) -> usize {
        let Some(forwards) = self.sessions.remove(session_id) else {
            return 0;
        };
        let count = forwards.len();
        for entry in forwards.into_values() {
            entry.abort.abort();
        }
        count
    }

    #[cfg(test)]
    fn count(&self, session_id: &str) -> usize {
        self.sessions
            .get(session_id)
            .map(|forwards| forwards.len())
            .unwrap_or(0)
    }
}

static FORWARDS: OnceLock<Mutex<ForwardRegistry>> = OnceLock::new();

fn forwards() -> &'static Mutex<ForwardRegistry> {
    FORWARDS.get_or_init(|| Mutex::new(ForwardRegistry::new()))
}

fn with_registry<R>(f: impl FnOnce(&mut ForwardRegistry) -> R) -> Result<R, String> {
    let mut guard = forwards()
        .lock()
        .map_err(|_| "SSH 转发表锁失败".to_string())?;
    Ok(f(&mut guard))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 端口校验：本地/远端端口都必须在 1..=65535（u16 已保证上界）。
pub(super) fn validate_ports(local_port: u16, remote_port: u16) -> Result<(), String> {
    if local_port == 0 {
        return Err("本地端口必须大于 0".to_string());
    }
    if remote_port == 0 {
        return Err("远端端口必须大于 0".to_string());
    }
    Ok(())
}

/// 远端主机校验（去空白、非空）。
pub(super) fn validate_remote_host(remote_host: &str) -> Result<String, String> {
    let trimmed = remote_host.trim();
    if trimmed.is_empty() {
        return Err("远端主机不能为空".to_string());
    }
    Ok(trimmed.to_string())
}

/// 会话断开时清理该会话全部转发（由 session 读任务 / disconnect 调用）。
pub(super) fn cleanup_session(session_id: &str) {
    let _ = with_registry(|registry| registry.cleanup_session(session_id));
}

/// 新增本地转发：绑定 127.0.0.1:local_port，接受连接后经 SSH 打开 direct-tcpip 通道。
#[tauri::command]
pub async fn ssh_forward_add(
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<SshForwardInfo, String> {
    validate_ports(local_port, remote_port)?;
    let remote_host = validate_remote_host(&remote_host)?;
    let handle = session_handle(&session_id)?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|err| format!("本地端口 {local_port} 绑定失败（可能已被占用）：{err}"))?;
    let info = SshForwardInfo {
        id: crate::infra::db::local_id(),
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
        created_at: now_secs(),
    };
    let info_for_task = info.clone();
    let remote_host_for_task = remote_host.clone();

    let abort = tokio::spawn(async move {
        loop {
            let (mut socket, _peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(err) => {
                    eprintln!(
                        "[ssh] 本地转发 {} 接受连接失败，停止监听：{err}",
                        info_for_task.id
                    );
                    break;
                }
            };
            let handle_for_conn = handle.clone();
            let remote_host_for_conn = remote_host_for_task.clone();
            tokio::spawn(async move {
                let channel = {
                    let guard = handle_for_conn.lock().await;
                    guard
                        .channel_open_direct_tcpip(
                            remote_host_for_conn,
                            remote_port as u32,
                            "127.0.0.1",
                            0,
                        )
                        .await
                };
                let channel = match channel {
                    Ok(channel) => channel,
                    Err(err) => {
                        eprintln!("[ssh] 本地转发打开远端通道失败：{err}");
                        return;
                    }
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    })
    .abort_handle();

    let info_for_registry = info.clone();
    with_registry(|registry| {
        registry.insert(
            &session_id,
            ForwardEntry {
                info: info_for_registry,
                abort,
            },
        );
    })?;
    Ok(info)
}

/// 移除一条本地转发（abort accept 循环，释放监听端口）。
#[tauri::command]
pub fn ssh_forward_remove(session_id: String, forward_id: String) -> Result<(), String> {
    let removed = with_registry(|registry| registry.remove(&session_id, &forward_id))?;
    match removed {
        None => Err(format!(
            "SSH 转发规则不存在：{forward_id}（会话 {session_id}）"
        )),
        Some(entry) => {
            entry.abort.abort();
            Ok(())
        }
    }
}

/// 列出会话内的本地转发。
#[tauri::command]
pub fn ssh_forward_list(session_id: String) -> Result<Vec<SshForwardInfo>, String> {
    session_handle(&session_id)?;
    with_registry(|registry| registry.list(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_abort() -> tokio::task::AbortHandle {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let handle = runtime.spawn(async {});
        handle.abort_handle()
    }

    fn entry(id: &str, local_port: u16, created_at: i64) -> ForwardEntry {
        ForwardEntry {
            info: SshForwardInfo {
                id: id.to_string(),
                local_port,
                remote_host: "10.0.0.8".to_string(),
                remote_port: 8080,
                created_at,
            },
            abort: dummy_abort(),
        }
    }

    #[test]
    fn ports_and_host_are_validated() {
        assert!(validate_ports(0, 80).expect_err("local 0").contains("本地端口"));
        assert!(validate_ports(8080, 0).expect_err("remote 0").contains("远端端口"));
        assert!(validate_ports(8080, 80).is_ok());
        assert!(validate_remote_host("  ").is_err());
        assert_eq!(validate_remote_host(" db.internal ").expect("host"), "db.internal");
    }

    #[test]
    fn forward_registry_insert_list_remove_and_cleanup() {
        let mut registry = ForwardRegistry::new();
        assert!(registry.list("s1").is_empty());
        registry.insert("s1", entry("b", 9002, 20));
        registry.insert("s1", entry("a", 9001, 10));
        registry.insert("s2", entry("c", 9003, 30));
        let infos = registry.list("s1");
        assert_eq!(
            infos.iter().map(|info| info.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(registry.count("s1"), 2);
        assert!(registry.remove("s1", "a").is_some());
        assert!(registry.remove("s1", "a").is_none());
        assert_eq!(registry.cleanup_session("s1"), 1);
        assert_eq!(registry.count("s1"), 0);
        assert_eq!(registry.cleanup_session("missing"), 0);
        assert_eq!(registry.count("s2"), 1);
    }

    #[test]
    fn forward_info_serializes_camel_case() {
        let info = SshForwardInfo {
            id: "f1".to_string(),
            local_port: 8080,
            remote_host: "10.0.0.8".to_string(),
            remote_port: 5432,
            created_at: 1_700_000_000,
        };
        let json = serde_json::to_string(&info).expect("serialize");
        assert!(json.contains("\"localPort\":8080"), "{json}");
        assert!(json.contains("\"remoteHost\":\"10.0.0.8\""), "{json}");
        assert!(json.contains("\"remotePort\":5432"), "{json}");
        assert!(json.contains("\"createdAt\":1700000000"), "{json}");
    }
}
