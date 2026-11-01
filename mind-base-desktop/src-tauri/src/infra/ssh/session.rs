//! 交互式 Shell 会话（PTY）：全局会话表 + 读写后台任务 + ssh-output / ssh-closed 事件。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client::Handle;
use russh::{ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter, State};

use crate::infra::db::Db;

use super::client::{connect_authenticated, interactive_client_config, ClientHandler};
use super::fingerprint::{check_fingerprint, remember_fingerprint, FingerprintVerdict};
use super::hosts::load_hosts;
use super::types::{
    SshClosedPayload, SshOutputPayload, SshSessionInfo, PTY_DEFAULT_COLS, PTY_DEFAULT_ROWS,
    PTY_TERM, SESSION_CONNECT_TIMEOUT_SECS,
};

/// 前端/内部投递给写任务的指令。
#[derive(Debug)]
enum SessionInput {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// 会话表中的一条记录：会话信息 + 写任务输入通道。
struct LiveSession {
    info: SshSessionInfo,
    input: tokio::sync::mpsc::UnboundedSender<SessionInput>,
    /// 可复用的 SSH Handle：SFTP / 端口转发借此开新 channel。
    /// 测试用会话为 None（不建立真实连接）。命令由 Lead 注册前暂无调用方。
    #[allow(dead_code)]
    handle: Option<Arc<tokio::sync::Mutex<Handle<ClientHandler>>>>,
}

/// 会话表（纯结构，便于单测；全局实例见 SESSIONS）。
#[derive(Default)]
struct SessionRegistry {
    sessions: HashMap<String, LiveSession>,
}

impl SessionRegistry {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    fn insert(&mut self, session: LiveSession) {
        self.sessions
            .insert(session.info.session_id.clone(), session);
    }

    fn get(&self, session_id: &str) -> Option<&LiveSession> {
        self.sessions.get(session_id)
    }

    fn remove(&mut self, session_id: &str) -> Option<LiveSession> {
        self.sessions.remove(session_id)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.sessions.len()
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// 稳定顺序：按连接时间，再按 session id。
    fn infos(&self) -> Vec<SshSessionInfo> {
        let mut infos: Vec<SshSessionInfo> = self
            .sessions
            .values()
            .map(|session| session.info.clone())
            .collect();
        infos.sort_by(|left, right| {
            left.connected_at
                .cmp(&right.connected_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        infos
    }
}

static SESSIONS: OnceLock<Mutex<SessionRegistry>> = OnceLock::new();

fn sessions() -> &'static Mutex<SessionRegistry> {
    SESSIONS.get_or_init(|| Mutex::new(SessionRegistry::new()))
}

fn with_registry<R>(f: impl FnOnce(&mut SessionRegistry) -> R) -> Result<R, String> {
    let mut guard = sessions()
        .lock()
        .map_err(|_| "SSH 会话表锁失败".to_string())?;
    Ok(f(&mut guard))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

fn input_sender(
    session_id: &str,
) -> Result<tokio::sync::mpsc::UnboundedSender<SessionInput>, String> {
    with_registry(|registry| registry.get(session_id).map(|session| session.input.clone()))?
        .ok_or_else(|| format!("SSH 会话不存在：{session_id}（可能已断开）"))
}

/// 取会话的可复用 Handle（SFTP / 本地转发用）；未知会话报中文错误。
/// 命令由 Lead 注册前暂无调用方（SFTP/转发命令注册后即被使用）。
#[allow(dead_code)]
pub(crate) fn session_handle(
    session_id: &str,
) -> Result<Arc<tokio::sync::Mutex<Handle<ClientHandler>>>, String> {
    with_registry(|registry| {
        registry
            .get(session_id)
            .and_then(|session| session.handle.clone())
    })?
    .ok_or_else(|| format!("SSH 会话不存在：{session_id}（可能已断开）"))
}

/// 追加会话日志；失败只警告一次，不影响读循环。
fn log_output(
    log_file: &mut Option<std::fs::File>,
    warned: &mut bool,
    data: &[u8],
    session_id: &str,
) {
    let Some(file) = log_file.as_mut() else {
        return;
    };
    if let Err(err) = super::log::append(file, data) {
        if !*warned {
            eprintln!("[ssh] 会话日志写入失败（{session_id}）：{err}（后续不再提示）");
            *warned = true;
        }
    }
}

fn send_input(session_id: &str, input: SessionInput) -> Result<(), String> {
    let sender = input_sender(session_id)?;
    sender
        .send(input)
        .map_err(|_| format!("SSH 会话已断开：{session_id}"))
}

fn emit_output(app: &AppHandle, session_id: &str, stream: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let payload = SshOutputPayload {
        session_id: session_id.to_string(),
        data: text.to_string(),
        stream: stream.to_string(),
    };
    let _ = app.emit("ssh-output", payload);
}

/// 从字节缓冲里取出最长的完整 UTF-8 前缀（不完整的多字节序列留在缓冲里等下一块）。
///
/// 交互终端输出按 Data 帧到达，一个汉字/emoji 可能被拆到两帧；直接
/// from_utf8_lossy 会把拆开的字符永久变成替换符，所以这里做增量解码。
fn drain_utf8(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let out = (!text.is_empty()).then(|| text.to_string());
            pending.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            match error.error_len() {
                // 非法字节序列：输出前缀 + 替换符，跳过坏字节，避免卡死。
                Some(len) => {
                    let prefix = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid + len);
                    Some(format!("{prefix}\u{fffd}"))
                }
                // 尾部是不完整的多字节序列：先把完整前缀发出去，尾部留待下一帧。
                None if valid > 0 => {
                    let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    Some(out)
                }
                None => None,
            }
        }
    }
}

fn emit_closed(app: &AppHandle, session_id: &str, reason: &str) {
    let payload = SshClosedPayload {
        session_id: session_id.to_string(),
        reason: reason.to_string(),
    };
    let _ = app.emit("ssh-closed", payload);
}

/// 交互式终端会话：连接 → 认证 → PTY → shell，随后后台读写任务持续转发。
///
/// 注意：交互终端是用户自己敲命令，**不经过** `remote_exec` 的命令黑名单
/// （黑名单只约束 agent 发起的一次性远程命令）。
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    db: State<'_, Db>,
    name: String,
) -> Result<SshSessionInfo, String> {
    let wanted = name.trim().to_string();
    if wanted.is_empty() {
        return Err("主机名称不能为空".to_string());
    }
    let host = load_hosts(db.inner())?
        .into_iter()
        .find(|host| host.name == wanted)
        .ok_or_else(|| {
            format!(
                "未找到名为 {wanted:?} 的远程服务器，请先在「系统设置 → 远程服务器」添加并保存"
            )
        })?;

    // 交互路径 TOFU：首次连接自动信任并写回指纹；已固定但不同则拒绝（防 MITM）。
    let fingerprint_slot = Arc::new(Mutex::new(None::<String>));
    let connect_slot = fingerprint_slot.clone();
    let stored_fingerprint = host.fingerprint.clone();
    let established = tokio::time::timeout(
        Duration::from_secs(SESSION_CONNECT_TIMEOUT_SECS),
        async {
            let session =
                connect_authenticated(&host, connect_slot, interactive_client_config()).await?;
            let actual = fingerprint_slot
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .unwrap_or_default();
            let verdict = check_fingerprint(&stored_fingerprint, &actual)?;
            let channel = session
                .channel_open_session()
                .await
                .map_err(|err| format!("SSH 打开交互通道失败：{err}"))?;
            channel
                .request_pty(true, PTY_TERM, PTY_DEFAULT_COLS, PTY_DEFAULT_ROWS, 0, 0, &[])
                .await
                .map_err(|err| format!("SSH 申请终端（PTY）失败：{err}"))?;
            channel
                .request_shell(true)
                .await
                .map_err(|err| format!("SSH 启动交互 shell 失败：{err}"))?;
            let (reader, writer) = channel.split();
            Ok::<_, String>((session, reader, writer, actual, verdict))
        },
    )
    .await
    .map_err(|_| {
        format!(
            "SSH 交互会话建立超时（{}s）：请检查网络或远端 sshd 状态",
            SESSION_CONNECT_TIMEOUT_SECS
        )
    })??;

    let (session, reader, writer, actual_fingerprint, verdict) = established;
    if verdict == FingerprintVerdict::TrustedNew && !actual_fingerprint.is_empty() {
        if let Err(err) = remember_fingerprint(db.inner(), &host.name, &actual_fingerprint) {
            eprintln!("[ssh] 首次连接指纹写回配置失败（{}）：{err}", host.name);
        }
    }
    // 会话日志（可选）：只记录终端输出；创建失败降级为不记录并警告。
    let now = now_secs();
    let mut log_path = String::new();
    let mut log_file: Option<std::fs::File> = None;
    if host.log_session {
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone();
        match super::log::open_session_log(&data_dir, &host, now) {
            Ok((path, file)) => {
                log_path = path.to_string_lossy().to_string();
                log_file = Some(file);
            }
            Err(err) => {
                eprintln!("[ssh] 会话日志创建失败（{}）：{err}", host.name);
            }
        }
    }

    let info = SshSessionInfo {
        session_id: crate::infra::db::local_id(),
        host_name: host.name.clone(),
        host: host.host.clone(),
        port: host.port,
        username: host.username.clone(),
        connected_at: now,
        log_path,
    };
    // 保留可复用 Handle：SFTP/转发可在会话存活期间开新 channel；写任务持 Arc 保活。
    let session_handle = Arc::new(tokio::sync::Mutex::new(session));
    let (input_tx, mut input_rx) = tokio::sync::mpsc::unbounded_channel();
    with_registry(|registry| {
        registry.insert(LiveSession {
            info: info.clone(),
            input: input_tx,
            handle: Some(session_handle.clone()),
        });
    })?;

    // 读任务：把 PTY 输出实时转发成 ssh-output；结束即广播 ssh-closed 并摘除会话。
    let read_app = app.clone();
    let read_session_id = info.session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = reader;
        let mut reason = "远端已关闭会话".to_string();
        let mut pending_stdout: Vec<u8> = Vec::new();
        let mut pending_stderr: Vec<u8> = Vec::new();
        let mut log_file = log_file;
        let mut log_warned = false;
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    log_output(&mut log_file, &mut log_warned, data.as_ref(), &read_session_id);
                    pending_stdout.extend_from_slice(data.as_ref());
                    if let Some(text) = drain_utf8(&mut pending_stdout) {
                        emit_output(&read_app, &read_session_id, "stdout", &text);
                    }
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    log_output(&mut log_file, &mut log_warned, data.as_ref(), &read_session_id);
                    pending_stderr.extend_from_slice(data.as_ref());
                    if let Some(text) = drain_utf8(&mut pending_stderr) {
                        emit_output(&read_app, &read_session_id, "stderr", &text);
                    }
                }
                ChannelMsg::Eof => {
                    reason = "远端已结束会话（EOF）".to_string();
                    break;
                }
                ChannelMsg::Close => {
                    reason = "远端已关闭会话".to_string();
                    break;
                }
                _ => {}
            }
        }
        // 会话结束时把尾部不完整字节按 lossy 输出，避免丢内容。
        if !pending_stdout.is_empty() {
            emit_output(
                &read_app,
                &read_session_id,
                "stdout",
                &String::from_utf8_lossy(&pending_stdout),
            );
        }
        if !pending_stderr.is_empty() {
            emit_output(
                &read_app,
                &read_session_id,
                "stderr",
                &String::from_utf8_lossy(&pending_stderr),
            );
        }
        emit_closed(&read_app, &read_session_id, &reason);
        // 会话断开：清理该会话的全部本地转发（abort accept 循环、释放端口）。
        super::forward::cleanup_session(&read_session_id);
        let _ = with_registry(|registry| registry.remove(&read_session_id));
    });

    // 写任务：用户输入 / resize / 主动关闭，持有 Handle Arc 保活。
    tauri::async_runtime::spawn(async move {
        let writer = writer;
        while let Some(input) = input_rx.recv().await {
            match input {
                SessionInput::Data(bytes) => {
                    if writer.data_bytes(bytes).await.is_err() {
                        break;
                    }
                }
                SessionInput::Resize(cols, rows) => {
                    if writer.window_change(cols, rows, 0, 0).await.is_err() {
                        break;
                    }
                }
                SessionInput::Close => break,
            }
        }
        let _ = writer.eof().await;
        let _ = writer.close().await;
        let guard = session_handle.lock().await;
        let _ = guard
            .disconnect(Disconnect::ByApplication, "", "zh-CN")
            .await;
    });

    Ok(info)
}

/// 向交互终端写入用户输入（原样 UTF-8 字节，回车等由前端发送）。
#[tauri::command]
pub fn ssh_write(session_id: String, data: String) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    send_input(&session_id, SessionInput::Data(data.into_bytes()))
}

/// 调整远端 PTY 尺寸。
#[tauri::command]
pub fn ssh_resize(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("终端尺寸必须大于 0".to_string());
    }
    send_input(&session_id, SessionInput::Resize(cols, rows))
}

/// 主动断开交互会话（后续由读任务广播 ssh-closed）。
#[tauri::command]
pub fn ssh_disconnect(session_id: String) -> Result<(), String> {
    let removed = with_registry(|registry| registry.remove(&session_id))?;
    match removed {
        None => Err(format!("SSH 会话不存在：{session_id}（可能已断开）")),
        Some(session) => {
            // 主动断开时立刻清理该会话的本地转发（读任务结束还会再清一次，幂等）。
            super::forward::cleanup_session(&session_id);
            let _ = session.input.send(SessionInput::Close);
            Ok(())
        }
    }
}

/// 列出当前活跃的交互会话（按连接时间升序）。
#[tauri::command]
pub fn ssh_sessions_list() -> Vec<SshSessionInfo> {
    let guard = sessions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.infos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_session(id: &str, connected_at: i64) -> LiveSession {
        let (input, _receiver) = tokio::sync::mpsc::unbounded_channel();
        LiveSession {
            info: SshSessionInfo {
                session_id: id.to_string(),
                host_name: "server".to_string(),
                host: "example.com".to_string(),
                port: 22,
                username: "root".to_string(),
                connected_at,
                log_path: String::new(),
            },
            input,
            handle: None,
        }
    }

    #[test]
    fn session_registry_insert_list_and_remove() {
        let mut registry = SessionRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);

        registry.insert(dummy_session("b", 20));
        registry.insert(dummy_session("a", 10));
        assert_eq!(registry.len(), 2);
        assert!(!registry.is_empty());
        assert_eq!(
            registry.get("a").map(|session| session.info.username.as_str()),
            Some("root")
        );
        assert!(registry.get("missing").is_none());

        // 按 connectedAt 升序，稳定排序。
        let ids: Vec<String> = registry
            .infos()
            .into_iter()
            .map(|info| info.session_id)
            .collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        let removed = registry.remove("a").expect("remove session");
        assert_eq!(removed.info.host_name, "server");
        assert!(registry.remove("a").is_none());
        assert_eq!(registry.len(), 1);
        let remaining = registry.infos();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].session_id, "b");
    }

    #[test]
    fn drain_utf8_waits_for_split_multibyte_sequences() {
        // "中" = E4 B8 AD，拆成两帧到达：第一帧不能输出替换符。
        let mut pending = vec![0xE4, 0xB8];
        assert_eq!(drain_utf8(&mut pending), None);
        pending.push(0xAD);
        assert_eq!(drain_utf8(&mut pending).as_deref(), Some("中"));
        assert!(pending.is_empty());

        // 完整 ASCII 直接输出。
        let mut pending = b"ok".to_vec();
        assert_eq!(drain_utf8(&mut pending).as_deref(), Some("ok"));

        // 非法字节：输出替换符并跳过坏字节，后续内容照常输出。
        let mut pending = vec![0xFF, b'a'];
        let text = drain_utf8(&mut pending).expect("invalid bytes decoded");
        assert!(text.contains('\u{fffd}'), "{text}");
        assert_eq!(drain_utf8(&mut pending).as_deref(), Some("a"));
    }
}
