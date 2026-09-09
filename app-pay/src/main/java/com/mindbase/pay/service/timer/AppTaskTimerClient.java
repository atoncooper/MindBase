package com.mindbase.pay.service.timer;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayTime;
import com.mindbase.pay.config.PayProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.client.RestClient;

import java.time.LocalDateTime;
import java.util.Map;

/**
 * 超时委托注册（plan/1.0.8）：下单事务提交后向 app-task 既有通用任务 API
 * （POST /tasks/register，key-auth）注册 task_type=http 的精确定时任务。
 *
 * 失败策略：仅告警 + 审计 TIMER_REGISTER_FAILED，不重试、不阻塞、不影响下单事务——
 * 兜底轮询（jittered backoff）接管，最终一致。task_id 携带版本，uniqueIndex 保证注册幂等。
 *
 * 注意：本类必须保持**单构造器**——多构造器时 Spring 无法隐式选择（会回退找无参构造器）。
 * 出站超时统一在 application.yaml 的 spring.http.client.*（连接 2s / 读 3s），
 * 注册在请求线程的 afterCommit 里执行，必须快速失败。
 */
@Slf4j
@Component
public class AppTaskTimerClient {

    private final RestClient restClient;
    private final PayProperties props;
    private final PayAuditLogger audit;

    public AppTaskTimerClient(RestClient.Builder builder, PayProperties props, PayAuditLogger audit) {
        this.restClient = builder
                .baseUrl(props.apptask().baseUrl())
                .defaultHeader("apikey", props.apptask().consumerKey())
                .build();
        this.props = props;
        this.audit = audit;
    }

    /** 必须在下单事务内调用：注册动作推迟到事务提交后执行（避免注册成功但订单回滚的幽灵任务）。 */
    public void registerOrderTimeoutAfterCommit(long uid, String orderNo, int version,
                                                LocalDateTime expiresAt) {
        if (!props.apptask().registerEnabled()) {
            return; // 纯兜底模式
        }
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    doRegister(uid, orderNo, version, expiresAt);
                }
            });
        } else {
            doRegister(uid, orderNo, version, expiresAt);
        }
    }

    private void doRegister(long uid, String orderNo, int version, LocalDateTime expiresAt) {
        String taskId = "PAYTIMEOUT-" + orderNo + "-v" + version;
        try {
            Map<String, Object> body = Map.of(
                    "uid", uid,
                    "task_type", "http",
                    "task_id", taskId,
                    "payload", Map.of("orderNo", orderNo, "version", version),
                    "executor_url", props.apptask().executorBaseUrl() + "/internal/pay/timeout/execute",
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
