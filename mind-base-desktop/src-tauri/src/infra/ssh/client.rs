//! russh 客户端：服务器公钥指纹记录、密码/私钥认证、连接建立。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};

use crate::infra::secret;

use super::types::{MAX_CAPTURE_BYTES, SESSION_KEEPALIVE_MAX, SESSION_KEEPALIVE_SECS};
use super::SshHostConfig;

/// russh 客户端事件处理：接受服务器公钥并记录 SHA256 指纹。
pub(crate) struct ClientHandler {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = format!(
            "{}",
            server_public_key.public_key().fingerprint(HashAlg::Sha256)
        );
        if let Ok(mut slot) = self.fingerprint.lock() {
            *slot = Some(fingerprint);
        }
        // MVP：首次连接即信任（TOFU）。指纹回传给调用方展示，方便用户核对。
        Ok(true)
    }
}

/// 把一段输出追加进缓冲；超过上限后只置截断标记，不再增长内存。
pub(crate) fn append_capped(buffer: &mut Vec<u8>, data: &[u8], truncated: &mut bool) {
    if buffer.len() >= MAX_CAPTURE_BYTES {
        *truncated = true;
        return;
    }
    let remaining = MAX_CAPTURE_BYTES - buffer.len();
    if data.len() > remaining {
        buffer.extend_from_slice(&data[..remaining]);
        *truncated = true;
    } else {
        buffer.extend_from_slice(data);
    }
}

/// 认证阶段：密码或私钥。
async fn authenticate(session: &mut Handle<ClientHandler>, host: &SshHostConfig) -> Result<(), String> {
    let auth = host.auth.trim().to_ascii_lowercase();
    let auth_result = match auth.as_str() {
        "password" => {
            if host.password.is_empty() {
                return Err(format!(
                    "远程服务器 {} 使用密码认证但密码为空，请在「系统设置 → 远程服务器」补全",
                    host.name
                ));
            }
            let password = secret::unprotect(&host.password);
            if password.is_empty() {
                return Err(format!(
                    "远程服务器 {} 的密码读取失败（系统凭据库不可用或凭据缺失）：\
                     请在「系统设置 → 远程服务器」重新填写密码",
                    host.name
                ));
            }
            session
                .authenticate_password(host.username.clone(), password)
                .await
                .map_err(|err| {
                    format!(
                        "SSH 密码认证失败（{}@{}）：{err}",
                        host.username, host.host
                    )
                })?
        }
        "key" => {
            let key_path = host.key_path.trim();
            if key_path.is_empty() {
                return Err(format!(
                    "远程服务器 {} 使用密钥认证但未填写私钥路径",
                    host.name
                ));
            }
            let key_text = std::fs::read_to_string(key_path)
                .map_err(|err| format!("读取 SSH 私钥失败（{key_path}）：{err}"))?;
            let passphrase_plain = secret::unprotect(&host.passphrase);
            if !host.passphrase.is_empty() && passphrase_plain.is_empty() {
                return Err(format!(
                    "远程服务器 {} 的私钥口令读取失败（系统凭据库不可用或凭据缺失）：\
                     请在「系统设置 → 远程服务器」重新填写私钥口令",
                    host.name
                ));
            }
            let passphrase = if passphrase_plain.is_empty() {
                None
            } else {
                Some(passphrase_plain.as_str())
            };
            let private_key = decode_secret_key(&key_text, passphrase).map_err(|err| {
                format!("解析 SSH 私钥失败（{key_path}）：{err}；请确认私钥格式与口令是否正确")
            })?;
            // RSA 私钥需要和服务器协商用的签名哈希（sha2-256/512）。
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            session
                .authenticate_publickey(
                    host.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(private_key), hash_alg),
                )
                .await
                .map_err(|err| {
                    format!(
                        "SSH 密钥认证失败（{}@{}）：{err}",
                        host.username, host.host
                    )
                })?
        }
        other => {
            return Err(format!(
                "远程服务器 {} 的认证方式 {other:?} 无效（只能是 password 或 key）",
                host.name
            ));
        }
    };
    if !auth_result.success() {
        return Err(format!(
            "SSH 认证被拒绝（{}@{}:{}）：用户名、密码或私钥不正确",
            host.username, host.host, host.port
        ));
    }
    Ok(())
}

/// 建立连接并完成认证（一次性 exec 与交互式 PTY 会话共用同一套认证逻辑）。
pub(crate) async fn connect_authenticated(
    host: &SshHostConfig,
    fingerprint: Arc<Mutex<Option<String>>>,
    config: client::Config,
) -> Result<Handle<ClientHandler>, String> {
    let handler = ClientHandler { fingerprint };
    let address = (host.host.as_str(), host.port);
    let mut session = client::connect(Arc::new(config), address, handler)
        .await
        .map_err(|err| format!("SSH 连接失败（{}:{}）：{err}", host.host, host.port))?;
    authenticate(&mut session, host).await?;
    Ok(session)
}

/// 交互会话的客户端配置：关闭 inactivity 超时，用 keepalive 维持长连接。
pub(crate) fn interactive_client_config() -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(SESSION_KEEPALIVE_SECS)),
        keepalive_max: SESSION_KEEPALIVE_MAX,
        ..Default::default()
    }
}
