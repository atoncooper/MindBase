package com.mindbase.pay.e2e.support;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 接口测试用 HTTP 客户端（只用于 src/test）。
 *
 * <p>为什么用 JDK 自带 HttpClient：
 * <ul>
 *   <li>不引入额外依赖，避免测试还要下载 HttpClient 库；</li>
 *   <li>支持连接复用/异步执行器，便于做并发压测；</li>
 *   <li>测试环境是自签名证书，这里可配置信任所有证书（仅测试）。</li>
 * </ul>
 *
 * <p>说明：JDK HttpClient 的连接池大小/keep-alive 由 JDK 内部系统属性控制，
 * 构造时按配置设置 jdk.httpclient.connectionPoolSize / jdk.httpclient.keepalive.timeout；
 * 若同一 JVM 里已经初始化过 HttpClient，属性可能不再生效，独立跑性能测试进程最稳。
 */
public final class PayTestHttpClient implements AutoCloseable {

    /** 自签名证书：测试进程启动时关闭 JDK HttpClient 主机名校验（仅在测试 classpath 中生效）。 */
    static {
        System.setProperty("jdk.internal.httpclient.disableHostnameVerification", "true");
    }

    private static final Pattern ORDER_NO_PATTERN =
            Pattern.compile("\"orderNo\"\\s*:\\s*\"([^\"]+)\"");

    private final PayTestConfig config;
    private final HttpClient client;
    private final ExecutorService clientExecutor;

    public PayTestHttpClient(PayTestConfig config) {
        this.config = config;
        this.clientExecutor = Executors.newFixedThreadPool(config.clientThreads(), runnable -> {
            Thread thread = new Thread(runnable, "pay-test-http");
            thread.setDaemon(true);
            return thread;
        });

        // JDK 内部属性必须在创建客户端/连接池前设置（0 表示不限制）
        if (config.maxConnections() > 0) {
            System.setProperty("jdk.httpclient.connectionPoolSize",
                    String.valueOf(config.maxConnections()));
        }
        if (config.keepAliveSeconds() > 0) {
            System.setProperty("jdk.httpclient.keepalive.timeout",
                    String.valueOf(config.keepAliveSeconds()));
        }
        if (config.disableHostnameVerification()) {
            System.setProperty("jdk.internal.httpclient.disableHostnameVerification", "true");
        }

        HttpClient.Builder builder = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(config.connectTimeoutMs()))
                .executor(clientExecutor);
        builder.version("HTTP_2".equalsIgnoreCase(config.httpVersion())
                ? HttpClient.Version.HTTP_2 : HttpClient.Version.HTTP_1_1);
        if (config.tlsInsecure()) {
            builder.sslContext(trustAllSslContext());
        }
        this.client = builder.build();
    }

    /** 响应结果：状态码 + 响应体 + 本次请求耗时（纳秒，性能测试用）。 */
    public record HttpResult(int status, String body, long latencyNanos) {

        public boolean success() {
            return status >= 200 && status < 300;
        }

        public String bodyOrEmpty() {
            return body == null ? "" : body;
        }
    }

    // ---------- 便捷方法 ----------

    public HttpResult get(String path, Map<String, String> headers) throws IOException, InterruptedException {
        return execute(requestBuilder(path, headers).GET().build());
    }

    public HttpResult getWithUid(String path, long uid) throws IOException, InterruptedException {
        return get(path, Map.of("X-Uid", String.valueOf(uid)));
    }

    public HttpResult getInternal(String path) throws IOException, InterruptedException {
        return get(path, Map.of("X-Internal-Key", config.internalKey()));
    }

    public HttpResult postJson(String path, String json, Map<String, String> headers)
            throws IOException, InterruptedException {
        HttpRequest request = requestBuilder(path, headers)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();
        return execute(request);
    }

    public HttpResult postForm(String path, String form, Map<String, String> headers)
            throws IOException, InterruptedException {
        HttpRequest request = requestBuilder(path, headers)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form, StandardCharsets.UTF_8))
                .build();
        return execute(request);
    }

    /** 测试入口调用：自动带 X-Test-Token。 */
    public HttpResult testEntryPostJson(String path, String json)
            throws IOException, InterruptedException {
        return postJson(path, json, Map.of("X-Test-Token", config.testToken()));
    }

    /** 健康检查（用于测试前判断服务是否已启动；失败返回 false，由测试用 Assumptions 跳过）。 */
    public boolean healthy() {
        try {
            return get("/health/live", Map.of()).status() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /** 从创建订单响应里取 orderNo（对象结构：{order:{orderNo:...}, payParams:{...}}）。 */
    public static String extractOrderNo(String json) {
        if (json == null) {
            return null;
        }
        Matcher matcher = ORDER_NO_PATTERN.matcher(json);
        return matcher.find() ? matcher.group(1) : null;
    }

    // ---------- 内部实现 ----------

    private HttpRequest.Builder requestBuilder(String path, Map<String, String> headers) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(config.baseUrl() + path))
                .timeout(Duration.ofMillis(config.requestTimeoutMs()));
        if (headers != null) {
            headers.forEach(builder::header);
        }
        return builder;
    }

    private HttpResult execute(HttpRequest request) throws IOException, InterruptedException {
        long startedAt = System.nanoTime();
        HttpResponse<String> response = client.send(request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        long latency = System.nanoTime() - startedAt;
        return new HttpResult(response.statusCode(), response.body(), latency);
    }

    private static SSLContext trustAllSslContext() {
        try {
            TrustManager[] trustAll = new TrustManager[]{
                    new X509TrustManager() {
                        @Override
                        public void checkClientTrusted(X509Certificate[] chain, String authType) {
                            // 测试环境：信任所有客户端证书
                        }

                        @Override
                        public void checkServerTrusted(X509Certificate[] chain, String authType) {
                            // 测试环境：信任所有服务端证书
                        }

                        @Override
                        public X509Certificate[] getAcceptedIssuers() {
                            return new X509Certificate[0];
                        }
                    }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustAll, new SecureRandom());
            return context;
        } catch (Exception e) {
            throw new IllegalStateException("failed to initialize test SSLContext", e);
        }
    }

    @Override
    public void close() {
        clientExecutor.shutdownNow();
    }
}