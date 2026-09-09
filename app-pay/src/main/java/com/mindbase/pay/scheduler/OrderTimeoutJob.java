package com.mindbase.pay.scheduler;

import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.mapper.PayOrderMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.UUID;

/**
 * 超时关单兜底（plan/1.0.8）：主路径是 app-task 精确定时委托（executor），
 * 本 job 为兜底——注册失败/app-task 宕机时由 jitter+自适应退避轮询接管，最终一致。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OrderTimeoutJob implements AdaptiveJob {

    private final PayOrderMapper orderMapper;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        MDC.put(TraceIdFilter.TRACE_ID, "job-timeout-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            LocalDateTime now = LocalDateTime.now(clock);
            int closed = orderMapper.closeExpired(now);
            lastHadWork = closed > 0;
            if (closed > 0) {
                log.info("[PAY] orders_closed_timeout count={} now={}", closed, now);
            }
        } finally {
            MDC.clear();
        }
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
