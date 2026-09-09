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
 * 超时委托的业务执行体（由 {@link TimeoutExecutionQueue} 的 worker 调用，受其并发钳制）。
 * 关单 = 按 (order_no, status=CREATED, version) 三条件更新；未命中即委托作废（订单已支付等）。
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
                // 幽灵任务容错：注册成功但订单不存在（理论不应发生）
                log.warn("[PAY] timeout_delegate_order_not_found expected_version={}", cmd.version());
                return ExecuteResult.skip("ORDER_NOT_FOUND");
            }
            if (order.getStatus() != PayOrder.OrderStatus.CREATED) {
                log.info("[PAY] timeout_delegate_skip_status status={}", order.getStatus());
                return ExecuteResult.skip("SKIP_STATUS:" + order.getStatus().name());
            }
            // 版本不匹配 = 注册后订单已被支付等更新（v1 委托作废）——用户方案的核心分支
            log.info("[PAY] timeout_delegate_discarded registered_version={} current_version={}",
                    cmd.version(), order.getVersion());
            return ExecuteResult.skip("SKIP_VERSION_MISMATCH");
        } finally {
            MDC.remove("orderNo");
        }
    }
}
