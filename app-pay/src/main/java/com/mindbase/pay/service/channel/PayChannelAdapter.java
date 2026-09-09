package com.mindbase.pay.service.channel;

import com.mindbase.pay.model.PayOrder;

import java.util.Map;

/**
 * 支付渠道适配器。M2 接入支付宝；M2.5 接微信 V3 时按同一接口新增实现即可，
 * 订单/交付/幂等/补偿逻辑不感知具体渠道。
 */
public interface PayChannelAdapter {

    PayOrder.PayChannel channel();

    /** 渠道是否已启用（配置齐全）。未启用的渠道在 requireAdapter 处被拒绝。 */
    boolean enabled();

    /**
     * 渠道下单，返回前端支付参数（支付宝当面付 = {type:alipay_qr, qrCode}）。
     * precreate 幂等（同一 orderNo 返回同一二维码），可用于重取码。
     */
    Map<String, Object> createPayment(PayOrder order);

    /** 主动查单（掉单补偿主路径）。 */
    ChannelQueryResult queryOrder(PayOrder order);
}
