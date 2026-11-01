//! 主机公钥指纹策略：首次连接 TOFU 信任，固定后拒绝变化（防中间人）。

use crate::infra::db::Db;

use super::hosts::update_host;

/// 主机指纹判定：匹配 / 首次信任（TOFU）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FingerprintVerdict {
    Matched,
    TrustedNew,
}

/// 主机指纹策略：空=首次信任；相同=匹配；不同=拒绝（防中间人）。
pub(crate) fn check_fingerprint(stored: &str, actual: &str) -> Result<FingerprintVerdict, String> {
    let stored = stored.trim();
    let actual = actual.trim();
    if stored.is_empty() {
        return Ok(FingerprintVerdict::TrustedNew);
    }
    if stored == actual {
        return Ok(FingerprintVerdict::Matched);
    }
    Err(format!(
        "SSH 主机指纹不匹配（已信任：{stored}；实际：{actual}）：可能是中间人攻击或服务器重装；请到「系统设置 → 远程服务器」重置指纹后重试"
    ))
}

/// TOFU：把实际指纹写回配置（best effort；失败只记录警告）。
pub(crate) fn remember_fingerprint(db: &Db, name: &str, fingerprint: &str) -> Result<(), String> {
    update_host(db, name, |host| {
        host.fingerprint = fingerprint.trim().to_string();
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_policy_trusts_first_sight_and_rejects_mismatch() {
        // 空指纹 = 首次连接（TOFU）。
        assert_eq!(
            check_fingerprint("", "SHA256:abc").expect("empty fingerprint trusts"),
            FingerprintVerdict::TrustedNew
        );
        assert_eq!(
            check_fingerprint("  ", "SHA256:abc").expect("blank fingerprint trusts"),
            FingerprintVerdict::TrustedNew
        );
        // 相同（含首尾空白）= 匹配。
        assert_eq!(
            check_fingerprint(" SHA256:abc ", "SHA256:abc").expect("matching fingerprint"),
            FingerprintVerdict::Matched
        );
        // 不同 = 拒绝，提示含密钥指纹信息。
        let err = check_fingerprint("SHA256:old", "SHA256:new").expect_err("mismatch rejected");
        assert!(err.contains("指纹不匹配"), "{err}");
        assert!(err.contains("SHA256:old") && err.contains("SHA256:new"), "{err}");
        assert!(err.contains("重置指纹"), "{err}");
    }
}
