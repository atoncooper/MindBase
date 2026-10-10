package com.mindbase.pay.service.timer;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDateTime;

/**
 * Business execution body for timeout delegation (called by {@link TimeoutExecutionQueue} workers,
 * subject to their concurrency limits). Closing an order = conditional update on the three conditions
 * (order_no, status=CREATED, version); a miss voids the delegation (order already paid, etc.).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TimeoutExecutionService {

    private final PayOrderMapper orderMapper;
    private final PayAuditLogger audit;
    private final Clock clock;

    public ExecuteResult execute(TimeoutCommand cmd) {
        MDC.put("orderNo", cmd.orderNo());
        try {
            LocalDateTime now = LocalDateTime.now(clock);
            int updated = orderMapper.closeOrderAtVersion(cmd.orderNo(), cmd.version(), now);
            if (updated == 1) {
                audit.audit("ORDER_CLOSED_TIMEOUT", "order_no", cmd.orderNo(),
                        "version", cmd.version(), "via", "app_task_executor");
                log.info("[PAY] order_closed_timeout via=app_task_executor");
                return ExecuteResult.ok();
            }
            PayOrder order = orderMapper.selectOne(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getOrderNo, cmd.orderNo()));
            if (order == null) {
                // ghost task tolerance: registration succeeded but the order does not exist (should not happen in theory)
                log.warn("[PAY] timeout_delegate_order_not_found expected_version={}", cmd.version());
                return ExecuteResult.skip("ORDER_NOT_FOUND");
            }
            if (order.getStatus() != PayOrder.OrderStatus.CREATED) {
                log.info("[PAY] timeout_delegate_skip_status status={}", order.getStatus());
                return ExecuteResult.skip("SKIP_STATUS:" + order.getStatus().name());
            }
            // version mismatch = the order was updated (e.g. paid) after registration, so the v1 delegation is voided -- the core branch of the design
            log.info("[PAY] timeout_delegate_discarded registered_version={} current_version={}",
                    cmd.version(), order.getVersion());
            return ExecuteResult.skip("SKIP_VERSION_MISMATCH");
        } finally {
            MDC.remove("orderNo");
        }
    }
}
