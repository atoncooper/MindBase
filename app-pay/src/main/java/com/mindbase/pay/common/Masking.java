package com.mindbase.pay.common;

/**
 * 买家信息掩码：对外（用户端/内部 API 响应）统一脱敏，数据库与 app-pay-admin
 * （直连库）保留全值。支付宝 buyer_logon_id 本身是半掩码（如 138****5678），这里再做一层
 * 归一化掩码；buyer_user_id 只保留末 4 位。null 原样返回。
 */
public final class Masking {

    private Masking() {
    }

    /** 支付宝登录号：邮箱保留首 2 字符 + 域名；手机号/其他保留前 3 后 2。 */
    public static String maskLogonId(String logonId) {
        if (logonId == null || logonId.isBlank()) {
            return logonId;
        }
        int at = logonId.indexOf('@');
        if (at > 0) {
            String local = logonId.substring(0, at);
            String domain = logonId.substring(at);
            int keep = Math.min(2, local.length());
            return local.substring(0, keep) + "***" + domain;
        }
        if (logonId.length() <= 4) {
            return "***";
        }
        return logonId.substring(0, 3) + "***" + logonId.substring(logonId.length() - 2);
    }

    /** 支付宝 userId：只保留末 4 位。 */
    public static String maskUserId(String userId) {
        if (userId == null || userId.isBlank()) {
            return userId;
        }
        if (userId.length() <= 4) {
            return "***";
        }
        return "***" + userId.substring(userId.length() - 4);
    }
}
