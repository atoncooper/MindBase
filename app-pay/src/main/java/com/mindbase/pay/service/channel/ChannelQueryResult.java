package com.mindbase.pay.service.channel;

/**
 * 渠道查单结果（ChannelQueryJob 用）。
 * NOT_PAID 含"订单不存在"（买家未扫码）与查询暂时失败——下轮再查，不误判。
 */
public record ChannelQueryResult(Status status, String tradeNo, Long paidAmountCents) {

    public enum Status {PAID, NOT_PAID, CLOSED}

    public static ChannelQueryResult paid(String tradeNo, Long paidAmountCents) {
        return new ChannelQueryResult(Status.PAID, tradeNo, paidAmountCents);
    }

    public static ChannelQueryResult notPaid() {
        return new ChannelQueryResult(Status.NOT_PAID, null, null);
    }

    public static ChannelQueryResult closed(String tradeNo) {
        return new ChannelQueryResult(Status.CLOSED, tradeNo, null);
    }
}
