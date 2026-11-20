package com.mindbase.pay.e2e.support;

import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

/**
 * 安全/性能测试配置读取器（只用于 src/test，不会进入生产包）。
 *
 * <p>直接读取 classpath:pay-test.properties，不做环境变量注入、不做 -D 覆盖、
 * 不读取外部文件；要调参就直接改 src/test/resources/pay-test.properties。
 *
 * <p>本配置只控制“测试客户端”（目标地址、令牌、并发、超时、阈值）；
 * 服务端 Tomcat 线程/Hikari 连接池/缓冲区等请改 app-pay/config-test.yaml 后重启容器。
 */
public final class PayTestConfig {

    private static final String DEFAULT_RESOURCE = "pay-test.properties";

    private final Properties properties;

    private PayTestConfig(Properties properties) {
        this.properties = properties;
    }

    /** 直接读取 classpath:pay-test.properties（UTF-8 无 BOM；唯一的测试客户端配置来源）。 */
    public static PayTestConfig load() {
        Properties properties = new Properties();
        try (InputStream in = PayTestConfig.class.getClassLoader()
                .getResourceAsStream(DEFAULT_RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource " + DEFAULT_RESOURCE
                        + " (expected under src/test/resources)");
            }
            // Properties.load(InputStream) 按 ISO-8859-1 解析，中文值会乱码；
            // 这里显式按 UTF-8 解码，并容忍“UTF-8 with BOM”（去掉 BOM 再解析）。
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            if (!text.isEmpty() && text.charAt(0) == '\uFEFF') {
                text = text.substring(1);
            }
            properties.load(new StringReader(text));
        } catch (IOException e) {
            throw new IllegalStateException("failed to read " + DEFAULT_RESOURCE, e);
        }
        return new PayTestConfig(properties);
    }

    // ---------- 基础设施 ----------

    private String str(String key, String defaultValue) {
        String value = properties.getProperty(key);
        return value == null || value.isBlank() ? defaultValue : value.trim();
    }

    private int integer(String key, int defaultValue) {
        String value = str(key, null);
        if (value == null) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("config " + key + " is not an integer: " + value, e);
        }
    }

    private long longValue(String key, long defaultValue) {
        String value = str(key, null);
        if (value == null) {
            return defaultValue;
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("config " + key + " is not a long: " + value, e);
        }
    }

    private boolean bool(String key, boolean defaultValue) {
        String value = str(key, null);
        return value == null ? defaultValue : Boolean.parseBoolean(value);
    }

    private double decimal(String key, double defaultValue) {
        String value = str(key, null);
        if (value == null) {
            return defaultValue;
        }
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("config " + key + " is not a decimal: " + value, e);
        }
    }

    // ---------- 目标与令牌 ----------

    public boolean testEnabled() {
        return bool("pay.test.enabled", true);
    }

    public String baseUrl() {
        String url = str("pay.base-url", "https://127.0.0.1:18002");
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    public String testToken() {
        return str("pay.test-token", "pay-test-token");
    }

    public String internalKey() {
        return str("pay.internal-key", "pay-test-internal-key");
    }

    /** Token for the timeout executor endpoint (/internal/pay/timeout/execute?token=...). */
    public String executorToken() {
        return str("pay.executor-token", "pay-test-executor-token");
    }

    // ---------- HTTP 客户端 ----------

    public int connectTimeoutMs() {
        return integer("http.connect-timeout-ms", 2_000);
    }

    public int requestTimeoutMs() {
        return integer("http.request-timeout-ms", 10_000);
    }

    public int clientThreads() {
        return Math.max(2, integer("http.client-threads", 8));
    }

    public String httpVersion() {
        return str("http.version", "HTTP_1_1");
    }

    public boolean tlsInsecure() {
        return bool("http.tls-insecure", true);
    }

    public boolean disableHostnameVerification() {
        return bool("http.disable-hostname-verification", true);
    }

    public int maxConnections() {
        return Math.max(0, integer("http.max-connections", 0));
    }

    public int keepAliveSeconds() {
        return Math.max(0, integer("http.keep-alive-seconds", 0));
    }

    // ---------- 安全测试 ----------

    public boolean securityEnabled() {
        return bool("security.enabled", true);
    }

    // ---------- 性能测试 ----------

    public boolean perfEnabled() {
        return bool("perf.enabled", false);
    }

    public String perfScenario() {
        String scenario = str("perf.scenario", "read").toLowerCase();
        return switch (scenario) {
            case "read", "write", "mixed", "user-write", "user-read",
                    "cache-miss", "hot-key" -> scenario;
            default -> throw new IllegalArgumentException(
                    "perf.scenario must be read/write/mixed/user-write/user-read/"
                            + "cache-miss/hot-key: " + scenario);
        };
    }

    public int perfThreads() {
        return Math.max(1, integer("perf.threads", 20));
    }

    public int perfWarmupSeconds() {
        return Math.max(0, integer("perf.warmup-seconds", 30));
    }

    public int perfWarmupThreads() {
        return Math.max(1, integer("perf.warmup-threads", 1));
    }

    public int perfDurationSeconds() {
        return Math.max(1, integer("perf.duration-seconds", 120));
    }

    public double perfMaxErrorRate() {
        return Math.max(0.0, decimal("perf.max-error-rate", 0.01));
    }

    public int perfMinSamples() {
        return Math.max(0, integer("perf.min-samples", 1_000));
    }

    public long perfThresholdP50Ms() {
        return longValue("perf.threshold-p50-ms", 100);
    }

    public long perfThresholdP99Ms() {
        return longValue("perf.threshold-p99-ms", 300);
    }

    public long perfThresholdP999Ms() {
        return longValue("perf.threshold-p999-ms", 800);
    }

    public boolean perfAssertThresholds() {
        return bool("perf.assert-thresholds", true);
    }

    public int perfPayloadPaddingBytes() {
        return Math.max(0, integer("perf.payload-padding-bytes", 0));
    }

    /** HTTP retries per request on connection/timeout errors (0 = no retry). */
    public int httpMaxRetries() {
        return Math.max(0, integer("http.max-retries", 0));
    }

    /** Enable actuator/Prometheus metric sampling during load tests. */
    public boolean metricsEnabled() {
        return bool("metrics.enabled", true);
    }

    /** Metrics scrape interval in seconds. */
    public int metricsIntervalSeconds() {
        return Math.max(1, integer("metrics.interval-seconds", 5));
    }

    /** Number of fresh TCP/TLS connections to time before the load phase. */
    public int metricsConnectionProbeSamples() {
        return Math.max(0, integer("metrics.connection-probe-samples", 3));
    }

    /** Optional concurrency ramp, e.g. "10,20,50,100"; empty = single run. */
    public int[] perfRampThreads() {
        String raw = str("perf.ramp-threads", "");
        if (raw == null || raw.isBlank()) {
            return new int[0];
        }
        String[] parts = raw.split("[,\\s]+");
        int[] values = new int[parts.length];
        int count = 0;
        for (String part : parts) {
            if (part.isBlank()) {
                continue;
            }
            try {
                int value = Integer.parseInt(part.trim());
                if (value > 0) {
                    values[count++] = value;
                }
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("perf.ramp-threads contains a non-integer: " + part, e);
            }
        }
        return java.util.Arrays.copyOf(values, count);
    }

    /** Duration of each ramp step in seconds. */
    public int perfRampStepSeconds() {
        return Math.max(1, integer("perf.ramp-step-seconds", 15));
    }

    /** Minimum QPS target (0 = disabled). */
    public double perfMinQps() {
        return Math.max(0.0, decimal("perf.min-qps", 0.0));
    }

    /** Minimum OPS target (successful HTTP operations/sec; 0 = disabled). */
    public double perfMinOps() {
        return Math.max(0.0, decimal("perf.min-ops", 0.0));
    }

    /** p95 latency threshold in milliseconds (0 = disabled). */
    public long perfThresholdP95Ms() {
        return longValue("perf.threshold-p95-ms", 250);
    }

    /** p99.99 latency threshold in milliseconds (0 = disabled). */
    public long perfThresholdP9999Ms() {
        return longValue("perf.threshold-p9999-ms", 2_000);
    }

    /** Availability target percentage, e.g. 99.9 or 99.99 (0 = disabled). */
    public double perfAvailabilityTarget() {
        return Math.max(0.0, decimal("perf.availability-target", 99.9));
    }

    /** 压测进度日志间隔（秒）；默认 10。 */
    public int perfLogIntervalSeconds() {
        return Math.max(1, integer("perf.log-interval-seconds", 10));
    }

    /** 每个阶段最多打印多少条错误样本（避免压测把日志打爆）；默认 10。 */
    public int perfMaxLoggedErrors() {
        return Math.max(0, integer("perf.max-logged-errors", 10));
    }

}