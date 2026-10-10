package com.mindbase.pay.service.channel;

import com.mindbase.pay.model.PayOrder;

import java.util.Map;

/**
 * Payment channel adapter. M2 adds Alipay; adding WeChat V3 in M2.5 only needs another implementation of this
 * interface, since the order/delivery/idempotency/compensation logic is channel-agnostic.
 */
public interface PayChannelAdapter {

    PayOrder.PayChannel channel();

    /** Whether the channel is enabled (fully configured). Disabled channels are rejected at requireAdapter. */
    boolean enabled();

    /**
     * Places the order at the channel and returns the frontend payment params
     * (Alipay face-to-face = {type:alipay_qr, qrCode}).
     * precreate is idempotent (the same orderNo returns the same QR), so it can be used to re-fetch the code.
     */
    Map<String, Object> createPayment(PayOrder order);

    /** Active order query (the main path for missed-payment compensation). */
    ChannelQueryResult queryOrder(PayOrder order);

    /**
     * Channel refund (M4 reversal). Implementations must be idempotent: repeated calls for the same order must not
     * produce a second payout (Alipay passes out_request_no; Mock succeeds directly).
     */
    RefundResult refund(PayOrder order, String reason);
}
