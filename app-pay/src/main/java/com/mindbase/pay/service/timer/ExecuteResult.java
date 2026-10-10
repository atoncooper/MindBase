package com.mindbase.pay.service.timer;

/**
 * Result of a timeout delegation execution. Conventions for reason when executed=false (plan/1.0.8 §5.2):
 * ORDER_NOT_FOUND (ghost task tolerance) / SKIP_STATUS:&lt;status&gt; / SKIP_VERSION_MISMATCH (order already
 * paid, delegation voided). 2xx + executed=false means success to app-task (completed, no retry).
 */
public record ExecuteResult(boolean executed, String reason) {

    public static ExecuteResult ok() {
        return new ExecuteResult(true, "EXECUTED");
    }

    public static ExecuteResult skip(String reason) {
        return new ExecuteResult(false, reason);
    }
}
