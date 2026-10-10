package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayOrder;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;

/**
 * Order Mapper. BaseMapper provides built-in single-table CRUD; hand-written SQL (state-machine
 * conditional updates) is centralized in resources/mapper/PayOrderMapper.xml, with method signatures
 * corresponding one-to-one to XML ids.
 */
public interface PayOrderMapper extends BaseMapper<PayOrder> {

    /**
     * CREATED -> PAID.
     *
     * @return affected row count; 0 means the order is not in CREATED (already paid/closed)
     */
    int markPaid(@Param("orderNo") String orderNo,
                 @Param("tradeNo") String channelTradeNo,
                 @Param("paidAt") LocalDateTime paidAt);

    /** CLOSED -> PAID: repair a late payment after the order was closed (called only after channel signature verification/query confirms the payment; the M4 refund path handles the reverse). */
    int markPaidAfterClose(@Param("orderNo") String orderNo,
                           @Param("tradeNo") String channelTradeNo,
                           @Param("paidAt") LocalDateTime paidAt);

    /**
     * Timeout delegation executor (plan/1.0.8): close the order at the version captured at registration.
     *
     * @return affected row count; 0 = version mismatch (the order was updated, e.g. paid, so the
     * delegation is void) or the status is not CREATED
     */
    int closeOrderAtVersion(@Param("orderNo") String orderNo,
                            @Param("version") int version,
                            @Param("now") LocalDateTime now);

    /** PAID -> DELIVERED. */
    int markDelivered(@Param("orderNo") String orderNo, @Param("now") LocalDateTime now);

    /** CREATED -> CLOSED (explicitly closing a single order). */
    int closeOrder(@Param("orderNo") String orderNo, @Param("now") LocalDateTime now,
                   @Param("reason") String reason);

    /** Batch close for timed-out orders (OrderTimeoutJob). */
    int closeExpired(@Param("now") LocalDateTime now);

    /**
     * PAID|DELIVERED -> REFUNDING (refund accepted, preventing concurrent duplicate refunds).
     * Also writes the previous status into refund_prev_status for rollback when the channel refund fails.
     *
     * @return affected row count; 0 = status does not qualify (already refunded/closed, etc.)
     */
    int markRefunding(@Param("orderNo") String orderNo,
                      @Param("refundNo") String refundNo,
                      @Param("reason") String reason,
                      @Param("now") LocalDateTime now);

    /** REFUNDING -> REFUNDED (channel refund succeeded). */
    int markRefunded(@Param("orderNo") String orderNo,
                     @Param("refundNo") String refundNo,
                     @Param("now") LocalDateTime now);

    /** REFUNDING -> previous status (rollback when the channel refund fails; does not wrongly trigger delivery compensation). */
    int revertRefunding(@Param("orderNo") String orderNo, @Param("now") LocalDateTime now);
}
