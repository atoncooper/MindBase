package com.mindbase.pay.scheduler;

import com.mindbase.pay.config.PayProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;

/** 兜底轮询的触发器接线：base/退避 cap 参数来自 pay.job 配置。 */
@Slf4j
@Configuration
@RequiredArgsConstructor
public class JobSchedulingConfig implements SchedulingConfigurer {

    private final OrderTimeoutJob orderTimeoutJob;
    private final DeliveryRetryJob deliveryRetryJob;
    private final ChannelQueryJob channelQueryJob;
    private final PayProperties props;

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        // job 抛异常不许杀死调度循环：统一 [PAY] 前缀 + 完整堆栈，下一轮照常触发
        var scheduler = new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();
        scheduler.setThreadNamePrefix("pay-job-");
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
                Duration.ofSeconds(job.queryBaseSeconds()), 0.3)); // cap==base：不退避
    }
}
