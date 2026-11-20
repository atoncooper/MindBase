package com.mindbase.pay.common;

/**
 * 日志/审计字段清洗：外部输入（回调 form、grant/refund 的 reason/operator）可能携带换行与控制字符，
 * 直接拼进日志可伪造日志行（log injection）。所有“外部字符串进日志”的统一走这里。
 */
public final class LogSanitizer {

    private static final int DEFAULT_MAX_LEN = 128;

    private LogSanitizer() {
    }

    /** 去除 CR/LF 等控制字符并截断；null 返回 "-"。 */
    public static String safe(String value) {
        return safe(value, DEFAULT_MAX_LEN);
    }

    public static String safe(String value, int maxLen) {
        if (value == null) {
            return "-";
        }
        StringBuilder sb = new StringBuilder(Math.min(value.length(), maxLen));
        for (int i = 0; i < value.length() && sb.length() < maxLen; i++) {
            char c = value.charAt(i);
            if (c == '\r' || c == '\n' || c == '\t' || Character.isISOControl(c)) {
                sb.append('_');
            } else {
                sb.append(c);
            }
        }
        return sb.length() == 0 ? "-" : sb.toString();
    }
}
