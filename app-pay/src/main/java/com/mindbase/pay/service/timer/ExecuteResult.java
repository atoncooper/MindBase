package com.mindbase.pay.service.timer;

/**
 * 超时委托执行结果。executed=false 的 reason 约定（plan/1.0.8 §5.2）：
 * ORDER_NOT_FOUND（幽灵任务容错）/ SKIP_STATUS:&lt;状态&gt; / SKIP_VERSION_MISMATCH（订单已支付，委托作废）。
 * 2xx + executed=false 对 app-task 而言 = 处理成功（completed，不重试）。
 */
public record ExecuteResult(boolean executed, String reason) {

    public static ExecuteResult ok() {
        return new ExecuteResult(true, "EXECUTED");
    }

    public static ExecuteResult skip(String reason) {
        return new ExecuteResult(false, reason);
    }
}
