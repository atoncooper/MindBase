package com.mindbase.pay.mapper;

/** 支付频次风控投影：单 uid 滚动 24h 的成功支付笔数与金额合计（pay_orderMapper.sumPaidSince）。 */
public class PaidOrderSummary {

    private long cnt;
    private long total;

    public long getCnt() { return cnt; }
    public void setCnt(long cnt) { this.cnt = cnt; }
    public long getTotal() { return total; }
    public void setTotal(long total) { this.total = total; }
}
