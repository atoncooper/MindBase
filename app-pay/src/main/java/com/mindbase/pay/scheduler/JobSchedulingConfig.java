package com.mindbase.pay.scheduler;

import com.mindbase.pay.config.PayProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;

/** Trigger wiring for fallback polling: base/backoff cap parameters come from the pay.job config. */
@Slf4j
@Configuration
@RequiredArgsConstructor
public class JobSchedulingConfig implements SchedulingConfigurer {

    private final OrderTimeoutJob orderTimeoutJob;
    private final DeliveryRetryJob deliveryRetryJob;
    private final ChannelQueryJob channelQueryJob;
    private final ReconciliationJob reconciliationJob;
    private final PayProperties props;

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        // A job exception must not kill the scheduling loop: unified [PAY] prefix + full stack trace, next round still fires
        var scheduler = new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();
        scheduler.setThreadNamePrefix("pay-job-");
        // Pool > 1: 兜底 Job 每轮含多次渠道出网（已并行到 payJobQueryExecutor），单线程会阻塞关单/交付补偿
        scheduler.setPoolSize(Math.max(2, props.job().schedulerPoolSize()));
        scheduler.setErrorHandler(t -> log.error("[PAY] job_execution_error", t));
        scheduler.initialize();
        registrar.setTaskScheduler(scheduler);
        PayProperties.Job job = props.job();
        registrar.addTriggerTask(orderTimeoutJob::run, new JitteredBackoffTrigger(
                orderTimeoutJob,
                Duration.ofSeconds(job.timeoutBaseSeconds()),
                Duration.ofSeconds(job.timeoutCapSeconds()), 0.3));
        registrar.addTriggerTask(deliveryRetryJob::run, new JitteredBackoffTrigger(
                deliveryRetryJob,
                Duration.ofSeconds(job.deliveryBaseSeconds()),
                Duration.ofSeconds(job.deliveryCapSeconds()), 0.3));
        registrar.addTriggerTask(channelQueryJob::run, new JitteredBackoffTrigger(
                channelQueryJob,
                Duration.ofSeconds(job.queryBaseSeconds()),
                Duration.ofSeconds(job.queryBaseSeconds()), 0.3)); // cap==base: no backoff
        registrar.addTriggerTask(reconciliationJob::run, new JitteredBackoffTrigger(
                reconciliationJob,
                Duration.ofSeconds(job.reconBaseSeconds()),
                Duration.ofSeconds(job.reconBaseSeconds()), 0.3)); // reconciliation at a fixed low-frequency interval
    }
}
