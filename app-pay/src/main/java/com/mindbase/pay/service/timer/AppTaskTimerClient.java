package com.mindbase.pay.service.timer;

import jakarta.annotation.PreDestroy;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayTime;
import com.mindbase.pay.config.PayProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.client.RestClient;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Timeout delegation registration (plan/1.0.8): after the order transaction commits, registers a
 * precise timed task with task_type=http via app-task's existing generic task API
 * (POST /tasks/register, key-auth).
 *
 * Failure strategy: warn only + audit TIMER_REGISTER_FAILED; no retry, no blocking, no impact on the
 * order transaction -- fallback polling (jittered backoff) takes over, eventual consistency. task_id
 * carries the version, and uniqueIndex guarantees registration idempotency.
 *
 * Note: this class must keep a **single constructor** -- with multiple constructors Spring cannot
 * choose implicitly (it would fall back to a no-arg constructor). Outbound timeouts are centralized in
 * application.yaml spring.http.client.* (connect 2s / read 3s).
 *
 * <p><b>注册异步化</b>：afterCommit 只把注册任务投递到有界线程池，出网 HTTP 不再占用
 * 请求线程（原来每笔建单最多阻塞 5s，高并发下 200 个 Tomcat 线程会被慢注册灌满）。队列满/池
 * 拒绝 = warn + 审计后放弃（兜底轮询接管），语义与注册失败一致。
 */
@Slf4j
@Component
public class AppTaskTimerClient implements AutoCloseable {

    private final RestClient restClient;
    private final PayProperties props;
    private final PayAuditLogger audit;
    private Executor registerExecutor;
    private final ThreadPoolExecutor ownedPool;

    public AppTaskTimerClient(RestClient.Builder builder, PayProperties props, PayAuditLogger audit) {
        this.restClient = builder
                .baseUrl(props.apptask().baseUrl())
                .defaultHeader("apikey", props.apptask().consumerKey())
                .build();
        this.props = props;
        this.audit = audit;
        int threads = Math.max(1, props.apptask().registerThreads());
        int capacity = Math.max(1, props.apptask().registerQueueCapacity());
        ThreadPoolExecutor pool = new ThreadPoolExecutor(threads, threads, 60, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(capacity),
                r -> {
                    Thread t = new Thread(r, "pay-timer-reg");
                    t.setDaemon(true);
                    return t;
                });
        pool.allowCoreThreadTimeOut(true);
        this.ownedPool = pool;
        this.registerExecutor = pool;
    }

    /** 测试注入口：换成同步执行器保证确定性（Spring 只见唯一公共构造器，不受影响）。 */
    void setRegisterExecutorForTest(Executor executor) {
        this.registerExecutor = executor;
    }

    @Override
    @PreDestroy
    public void close() {
        if (ownedPool != null) {
            ownedPool.shutdown();
            try {
                if (!ownedPool.awaitTermination(5, TimeUnit.SECONDS)) {
                    ownedPool.shutdownNow();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                ownedPool.shutdownNow();
            }
        }
    }

    /** Must be called inside the order transaction: the registration is deferred until after commit (avoids a ghost task that registers successfully while the order rolls back). */
    public void registerOrderTimeoutAfterCommit(long uid, String orderNo, int version,
                                                LocalDateTime expiresAt) {
        if (!props.apptask().registerEnabled()) {
            return; // fallback-only mode
        }
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    submitRegister(uid, orderNo, version, expiresAt);
                }
            });
        } else {
            submitRegister(uid, orderNo, version, expiresAt);
        }
    }

    /** 投递到有界线程池：请求线程不再做出网 HTTP；拒绝 = 兜底轮询接管（与注册失败同语义）。 */
    private void submitRegister(long uid, String orderNo, int version, LocalDateTime expiresAt) {
        try {
            registerExecutor.execute(() -> doRegister(uid, orderNo, version, expiresAt));
        } catch (RejectedExecutionException e) {
            log.warn("[PAY] timer_register_rejected order_no={} -- queue full, fallback polling takes over", orderNo);
            audit.audit("TIMER_REGISTER_REJECTED", "order_no", orderNo, "task_id",
                    "PAYTIMEOUT-" + orderNo + "-v" + version);
        }
    }

    /**
     * executor_url: the query string is appended only when a token is configured. app-task POSTs this
     * URL as-is, so the token reaches the executor endpoint for validation without any app-task change
     * (minimal hardening of the trust boundary).
     */
    String executorUrl() {
        String base = props.apptask().executorBaseUrl() + "/internal/pay/timeout/execute";
        String token = props.internal() == null ? null : props.internal().executorToken();
        if (token == null || token.isBlank()) {
            return base;
        }
        return base + "?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8);
    }

    private void doRegister(long uid, String orderNo, int version, LocalDateTime expiresAt) {
        String taskId = "PAYTIMEOUT-" + orderNo + "-v" + version;
        try {
            Map<String, Object> body = Map.of(
                    "uid", uid,
                    "task_type", "http",
                    "task_id", taskId,
                    "payload", Map.of("orderNo", orderNo, "version", version),
                    "executor_url", executorUrl(),
                    "trigger_time", expiresAt.atZone(PayTime.ZONE).toInstant().toString(),
                    "max_retry", 3);
            restClient.post()
                    .uri("/tasks/register")
                    .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
            log.info("[PAY] timer_registered task_id={} trigger_time={}", taskId, expiresAt);
        } catch (Exception e) {
            log.warn("[PAY] timer_register_failed task_id={} err={} -- fallback polling takes over", taskId, e.toString());
            audit.audit("TIMER_REGISTER_FAILED", "order_no", orderNo, "task_id", taskId);
        }
    }
}
