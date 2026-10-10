package com.mindbase.pay.service.channel;

/** Channel refund result. When success=false, error is a readable reason and the orchestration layer uses it to roll back the REFUNDING state. */
public record RefundResult(boolean success, String refundNo, String error) {

    public static RefundResult success(String refundNo) {
        return new RefundResult(true, refundNo, null);
    }

    public static RefundResult failure(String error) {
        return new RefundResult(false, null, error);
    }
}
