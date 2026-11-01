//! 敏感凭据的跨平台系统凭据库存储（keyring 4）+ 历史格式兼容。
//!
//! 存储格式（配置/数据库里只出现引用，不出现明文）：
//! - `keyring:<scope>`：凭据保存在系统凭据库（Windows Credential Manager /
//!   macOS Keychain / Linux Secret Service）；service 固定为
//!   [KEYRING_SERVICE]，username 即 scope（如 `ssh:<host>:password`）。
//! - `dpapi:<base64>`：历史（仅 Windows）DPAPI 密文，仍可解密；
//!   用户下次保存主机配置时自动迁移到系统凭据库。
//! - `plain:<明文>`：系统凭据库不可用时的降级（会 eprintln 警告，不安全）。
//! - 无前缀：更早期遗留明文（unprotect 原样返回，下次保存迁移）。
//!
//! 加密/解密只发生在持久化边界：内存与 UI 之间始终是明文。

#[cfg(windows)]
use base64::Engine as _;

use crate::infra::config::SshHostConfig;

const KEYRING_PREFIX: &str = "keyring:";
const DPAPI_PREFIX: &str = "dpapi:";
const PLAIN_PREFIX: &str = "plain:";
/// 系统凭据库里的 service 名（固定，不随主机变化）。
const KEYRING_SERVICE: &str = "mindbase-desktop";

fn is_wrapped(value: &str) -> bool {
    value.starts_with(KEYRING_PREFIX)
        || value.starts_with(DPAPI_PREFIX)
        || value.starts_with(PLAIN_PREFIX)
}

/// 主机凭据在系统凭据库中的 scope：ssh:<host>:<field>。
fn scope_for(host_name: &str, field: &str) -> String {
    format!("ssh:{host_name}:{field}")
}

fn store_in_keyring(scope: &str, plain: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, scope)
        .map_err(|err| format!("初始化系统凭据库失败：{err}"))?;
    entry
        .set_password(plain)
        .map_err(|err| format!("写入系统凭据库失败：{err}"))
}

fn read_from_keyring(scope: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, scope)
        .map_err(|err| format!("初始化系统凭据库失败：{err}"))?;
    entry
        .get_password()
        .map_err(|err| format!("读取系统凭据库失败：{err}"))
}

/// 删除一个 scope 对应的系统凭据库条目（best effort；不存在也不算错）。
fn forget_scope(scope: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, scope) {
        let _ = entry.delete_credential();
    }
}

/// 加密一个凭据：写入系统凭据库，成功返回 `keyring:<scope>`。
///
/// 系统凭据库不可用（如 Linux 没有 Secret Service、CI 无桌面会话）时退回
/// `plain:<明文>` 并打印警告，保证功能可用但明确告知不安全。
pub(crate) fn protect(scope: &str, plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    if is_wrapped(plain) {
        return plain.to_string();
    }
    match store_in_keyring(scope, plain) {
        Ok(()) => format!("{KEYRING_PREFIX}{scope}"),
        Err(err) => {
            eprintln!(
                "[secret] 系统凭据库不可用（{err}），SSH 凭据将以 plain 前缀明文存储（不安全）；scope={scope}"
            );
            format!("{PLAIN_PREFIX}{plain}")
        }
    }
}

/// 解密一个凭据引用：keyring → 系统凭据库；dpapi → 仅 Windows 历史迁移；
/// plain → 去前缀；无前缀 → 历史明文原样兼容。失败返回空串（调用方决定报错）。
pub(crate) fn unprotect(stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if let Some(scope) = stored.strip_prefix(KEYRING_PREFIX) {
        return match read_from_keyring(scope) {
            Ok(secret) => secret,
            Err(err) => {
                eprintln!("[secret] 读取系统凭据库失败（scope={scope}）：{err}");
                String::new()
            }
        };
    }
    if let Some(rest) = stored.strip_prefix(PLAIN_PREFIX) {
        return rest.to_string();
    }
    if let Some(rest) = stored.strip_prefix(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            let cipher = match base64::engine::general_purpose::STANDARD.decode(rest) {
                Ok(bytes) => bytes,
                Err(err) => {
                    eprintln!("[secret] DPAPI 密文损坏（base64 解析失败）：{err}");
                    return String::new();
                }
            };
            match dpapi_unprotect(&cipher) {
                Ok(bytes) => return String::from_utf8_lossy(&bytes).into_owned(),
                Err(err) => {
                    eprintln!("[secret] DPAPI 历史密文解密失败（凭据可能来自其它 Windows 账户）：{err}");
                    return String::new();
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = rest;
            eprintln!("[secret] 遇到 dpapi: 历史密文但当前平台不是 Windows，凭据不可用");
            return String::new();
        }
    }
    // 历史明文：原样兼容（下一次保存时迁移到系统凭据库）。
    stored.to_string()
}

/// 返回主机凭据的明文副本（ssh_hosts_list / get_config 给 UI 前调用）。
pub(crate) fn reveal_host_credentials(host: &SshHostConfig) -> SshHostConfig {
    let mut revealed = host.clone();
    revealed.password = unprotect(&host.password);
    revealed.passphrase = unprotect(&host.passphrase);
    revealed
}

pub(crate) fn reveal_hosts_credentials(hosts: &[SshHostConfig]) -> Vec<SshHostConfig> {
    hosts.iter().map(reveal_host_credentials).collect()
}

/// 返回主机凭据的引用副本（ssh_hosts_save / set_config 入库前调用）。
pub(crate) fn protect_host_credentials(host: &SshHostConfig) -> SshHostConfig {
    let mut protected = host.clone();
    protected.password = protect(&scope_for(&host.name, "password"), &host.password);
    protected.passphrase = protect(&scope_for(&host.name, "passphrase"), &host.passphrase);
    protected
}

pub(crate) fn protect_hosts_credentials(hosts: &[SshHostConfig]) -> Vec<SshHostConfig> {
    hosts.iter().map(protect_host_credentials).collect()
}

/// 删除一台主机在系统凭据库中的 password / passphrase 两条据。
///
/// 保存主机列表时对「被移除的主机」调用；best effort，失败只影响孤儿凭据。
pub(crate) fn forget_host_credentials(host_name: &str) {
    forget_scope(&scope_for(host_name, "password"));
    forget_scope(&scope_for(host_name, "passphrase"));
}

/// 历史 DPAPI 加密（仅测试/迁移验证用；生产只解密不加密）。
#[cfg(all(windows, test))]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("CryptProtectData 失败：{err}"))?;
        let cipher = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(cipher)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|err| format!("CryptUnprotectData 失败：{err}"))?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_scope(tag: &str) -> String {
        format!("test:{}:{tag}", crate::infra::db::local_id())
    }

    #[test]
    fn keyring_roundtrip_or_plain_fallback() {
        let scope = test_scope("password");
        let plain = "p@ss 词 with spaces";
        let protected = protect(&scope, plain);
        assert_eq!(unprotect(&protected), plain);
        if protected.starts_with(KEYRING_PREFIX) {
            assert_eq!(protected, format!("keyring:{scope}"));
        } else {
            // 系统凭据库不可用（CI 无桌面会话等）：降级为 plain:，仍可解出。
            assert!(protected.starts_with(PLAIN_PREFIX), "{protected}");
        }
        forget_scope(&scope);
        // 清理后再次读取应拿不到明文（keyring 路径）。
        if protected.starts_with(KEYRING_PREFIX) {
            assert_eq!(unprotect(&protected), "");
        }
    }

    #[test]
    fn legacy_plaintext_and_empty_values_are_compatible() {
        assert_eq!(unprotect("legacy-secret"), "legacy-secret");
        assert_eq!(unprotect("plain:visible"), "visible");
        assert_eq!(protect(&test_scope("empty"), ""), "");
        assert_eq!(unprotect(""), "");
    }

    #[test]
    fn protect_is_idempotent() {
        let scope = test_scope("idem");
        let once = protect(&scope, "abc");
        assert_eq!(protect(&scope, &once), once);
        forget_scope(&scope);
    }

    #[test]
    fn corrupted_references_degrade_to_empty_without_panic() {
        assert_eq!(unprotect("dpapi:not-base64"), "");
        assert_eq!(unprotect("dpapi:"), "");
        let missing = format!("keyring:test:missing:{}", crate::infra::db::local_id());
        assert_eq!(unprotect(&missing), "");
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_legacy_ciphertext_still_decrypts() {
        // 历史配置里的 dpapi: 密文仍可解密；下次保存会迁移到 keyring。
        let cipher = dpapi_protect(b"legacy secret").expect("dpapi protect");
        let stored = format!(
            "{DPAPI_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(cipher)
        );
        assert_eq!(unprotect(&stored), "legacy secret");
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_cannot_read_dpapi_ciphertext() {
        assert_eq!(unprotect("dpapi:AAAA"), "");
    }

    #[test]
    fn host_credentials_use_host_scopes_and_forget_cleans_entries() {
        let host = SshHostConfig {
            name: format!("host-{}", crate::infra::db::local_id()),
            password: "plain-password".to_string(),
            passphrase: "plain-passphrase".to_string(),
            ..Default::default()
        };
        let protected = protect_host_credentials(&host);
        assert!(
            protected.password.starts_with(KEYRING_PREFIX) || protected.password.starts_with(PLAIN_PREFIX),
            "{}",
            protected.password
        );
        let revealed = reveal_host_credentials(&protected);
        assert_eq!(revealed.password, "plain-password");
        assert_eq!(revealed.passphrase, "plain-passphrase");
        // reveal 后再 protect：幂等（不会二次加密）。
        let again = protect_host_credentials(&revealed);
        assert_eq!(again.password, protected.password);
        assert_eq!(again.passphrase, protected.passphrase);

        forget_host_credentials(&host.name);
    }
}
