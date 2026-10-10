package com.mindbase.pay.service.channel;

/**
 * Channel order-query result (used by ChannelQueryJob and order-read sync).
 * NOT_PAID covers both "order does not exist" (buyer has not scanned) and a transient query failure -- both are
 * retried rather than misjudged.
 * buyer fields come from the channel query/notification and are persisted to pay_order for order-detail
 * display, so the user can verify which account paid.
 */
public record ChannelQueryResult(Status status, String tradeNo, Long paidAmountCents,
                                 String buyerLogonId, String buyerUserId) {

    public enum Status {PAID, NOT_PAID, CLOSED}

    public static ChannelQueryResult paid(String tradeNo, Long paidAmountCents, String buyerLogonId, String buyerUserId) {
        return new ChannelQueryResult(Status.PAID, tradeNo, paidAmountCents, buyerLogonId, buyerUserId);
    }

    public static ChannelQueryResult notPaid() {
        return new ChannelQueryResult(Status.NOT_PAID, null, null, null, null);
    }

    public static ChannelQueryResult closed(String tradeNo) {
        return new ChannelQueryResult(Status.CLOSED, tradeNo, null, null, null);
    }
}
