package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayOrder;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDateTime;

/**
 * 订单 Mapper。BaseMapper 内置单表 CRUD；手写 SQL（状态机条件更新）
 * 集中在 resources/mapper/PayOrderMapper.xml，方法签名与 XML id 一一对应。
 */
public interface PayOrderMapper extends BaseMapper<PayOrder> {

    /**
     * CREATED -> PAID。
     *
     * @return 受影响行数，0 表示订单不处于 CREATED（已支付/已关闭）
     */
    int markPaid(@Param("orderNo") String orderNo,
                 @Param("tradeNo") String channelTradeNo,
                 @Param("paidAt") LocalDateTime paidAt);

    /** CLOSED -> PAID：关单后到账补单（仅渠道验签/查单确认已收款后调用，M4 退款路径负责逆向）。 */
    int markPaidAfterClose(@Param("orderNo") String orderNo,
                           @Param("tradeNo") String channelTradeNo,
                           @Param("paidAt") LocalDateTime paidAt);

    /**
     * 超时委托 executor（plan/1.0.8）：按注册时版本关单。
     *
     * @return 受影响行数，0 = 版本不匹配（订单已支付等更新，委托作废）或状态非 CREATED
     */
    int closeOrderAtVersion(@Param("orderNo") String orderNo,
                            @Param("version") int version,
                            @Param("now") LocalDateTime now);

    /** PAID -> DELIVERED。 */
    int markDelivered(@Param("orderNo") String orderNo, @Param("now") LocalDateTime now);

    /** CREATED -> CLOSED（单笔主动关单）。 */
    int closeOrder(@Param("orderNo") String orderNo, @Param("now") LocalDateTime now,
                   @Param("reason") String reason);

    /** 批量超时关单（OrderTimeoutJob）。 */
    int closeExpired(@Param("now") LocalDateTime now);
}
