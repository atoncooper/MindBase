//! 远程服务器配置读写命令：列表（解密）/ 保存（加密）/ 信任或清除指纹。

use std::collections::HashMap;

use tauri::State;

use crate::infra::config;
use crate::infra::db::Db;
use crate::infra::secret;

use super::SshHostConfig;

/// 读取已保存的远程服务器列表（磁盘原始值：password/passphrase 是密文）。
pub(crate) fn load_hosts(db: &Db) -> Result<Vec<SshHostConfig>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    Ok(config::load(&conn)?.ssh_hosts)
}

/// 按名称修改一台主机配置并保存；返回解密后的完整列表（UI 直接用）。
pub(crate) fn update_host<F>(db: &Db, name: &str, update: F) -> Result<Vec<SshHostConfig>, String>
where
    F: FnOnce(&mut SshHostConfig),
{
    let wanted = name.trim();
    if wanted.is_empty() {
        return Err("主机名称不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut app_config = config::load(&conn)?;
    let host = app_config
        .ssh_hosts
        .iter_mut()
        .find(|host| host.name == wanted)
        .ok_or_else(|| format!("未找到名为 {wanted:?} 的远程服务器"))?;
    update(host);
    config::save(&conn, &app_config)?;
    Ok(secret::reveal_hosts_credentials(&app_config.ssh_hosts))
}

/// Tauri 命令：列出已配置的远程服务器（凭据已解密，供设置页回填/编辑）。
#[tauri::command]
pub fn ssh_hosts_list(db: State<'_, Db>) -> Result<Vec<SshHostConfig>, String> {
    Ok(secret::reveal_hosts_credentials(&load_hosts(&db)?))
}

/// Tauri 命令：校验后全量保存远程服务器列表，返回保存后的列表（明文）。
///
/// 入参是设置页提交的明文凭据，落库前写入系统凭据库（配置里只留
/// keyring:<scope> 引用）。空 fingerprint 不会意外清掉库中已固定的指纹
/// （显式清除请用 ssh_host_forget_fingerprint）；被移除的主机其系统凭据库
/// 条目会一并清理。
#[tauri::command]
pub fn ssh_hosts_save(
    hosts: Vec<SshHostConfig>,
    db: State<'_, Db>,
) -> Result<Vec<SshHostConfig>, String> {
    let validated = config::validate_ssh_hosts(&hosts)?;
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut app_config = config::load(&conn)?;
    let stored_fingerprints: HashMap<String, String> = app_config
        .ssh_hosts
        .iter()
        .map(|host| (host.name.clone(), host.fingerprint.clone()))
        .collect();
    let mut merged: Vec<SshHostConfig> = Vec::with_capacity(validated.len());
    for mut host in validated {
        if host.fingerprint.is_empty() {
            if let Some(existing) = stored_fingerprints
                .get(&host.name)
                .filter(|fingerprint| !fingerprint.trim().is_empty())
            {
                host.fingerprint = existing.clone();
            }
        }
        merged.push(host);
    }
    // 全量替换：被移除的主机不再出现在配置里，顺手清理其系统凭据库条目。
    for previous in app_config.ssh_hosts.iter() {
        if !merged.iter().any(|host| host.name == previous.name) {
            secret::forget_host_credentials(&previous.name);
        }
    }
    app_config.ssh_hosts = secret::protect_hosts_credentials(&merged);
    config::save(&conn, &app_config)?;
    Ok(merged)
}

/// Tauri 命令：信任 / 更新主机公钥指纹（用户手动确认后）。
#[tauri::command]
pub fn ssh_host_trust_fingerprint(
    name: String,
    fingerprint: String,
    db: State<'_, Db>,
) -> Result<Vec<SshHostConfig>, String> {
    let fingerprint = fingerprint.trim().to_string();
    if fingerprint.is_empty() {
        return Err("主机指纹不能为空".to_string());
    }
    update_host(db.inner(), &name, |host| host.fingerprint = fingerprint)
}

/// Tauri 命令：清除已固定的主机指纹（下次交互连接重新 TOFU）。
#[tauri::command]
pub fn ssh_host_forget_fingerprint(
    name: String,
    db: State<'_, Db>,
) -> Result<Vec<SshHostConfig>, String> {
    update_host(db.inner(), &name, |host| host.fingerprint = String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_config_defaults_keep_security_fields_safe() {
        let host = SshHostConfig::default();
        assert!(host.fingerprint.is_empty(), "默认不信任任何主机");
        assert!(host.project_id.is_empty(), "默认不绑定项目");
        assert!(!host.allow_agent, "默认不允许 Agent 使用");
    }
}
