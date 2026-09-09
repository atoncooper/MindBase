package com.mindbase.pay.service.timer;

import com.mindbase.pay.config.PayProperties;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 超时执行的并发自守（plan/1.0.8 §5.3）：executor 端点不做 DB 操作，命令入本地有界 FIFO，
 * 固定 worker 池并行消费——DB 在途 UPDATE 恒 ≤ workers，与调用方（app-task）的分发行为彻底无关。
 *
 * 背压：队列满 → {@link QueueFullException} → 端点 503 → app-task 既有指数退避重试。
 * 崩溃语义：内存队列是优化不是正确性——崩溃丢队内命令，兜底轮询必然接管；
 * 优雅停机时排空队列。worker 数锚定 DB 连接池（Hikari 10 → 默认 8）。
 */
@Slf4j
@Component
public class TimeoutExecutionQueue {

    /** 队列满：端点转 503，调用方退避重试。 */
    public static class QueueFullException extends IllegalStateException {
        public QueueFullException() {
            super("executor queue full");
        }
    }

    private record Pending(TimeoutCommand cmd, CompletableFuture<ExecuteResult> future) {
    }

    private final LinkedBlockingQueue<Pending> queue;
    private final TimeoutExecutionService service;
    private final List<Thread> workers = new ArrayList<>();
    private volatile boolean running = true;

    public TimeoutExecutionQueue(TimeoutExecutionService service, PayProperties props) {
        this.service = service;
        PayProperties.Job job = props.job();
        this.queue = new LinkedBlockingQueue<>(Math.max(1, job.executorQueueCapacity()));
        for (int i = 0; i < Math.max(1, job.executorWorkers()); i++) {
            workers.add(new Thread(this::drainLoop, "pay-timeout-worker-" + i));
        }
    }

    @PostConstruct
    public void start() {
        workers.forEach(Thread::start);
        log.info("[PAY] timeout_execution_queue started workers={} capacity={}",
                workers.size(), queue.size() + queue.remainingCapacity());
    }

    /** 入队并等待本命令执行完成（同步语义，app-task 的 completed 保持真实）。 */
    public ExecuteResult submit(TimeoutCommand cmd) {
        CompletableFuture<ExecuteResult> future = new CompletableFuture<>();
        if (!queue.offer(new Pending(cmd, future))) {
            throw new QueueFullException();
        }
        try {
            return future.get(30, TimeUnit.SECONDS); // worker 卡死兜底：超时按异常上抛 → 5xx → 调用方重试
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting executor", e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;   // 500 语义：app-task 退避重试，条件更新幂等保证安全
            }
            throw new IllegalStateException(e.getCause());
        } catch (TimeoutException e) {
            throw new IllegalStateException("executor wait timeout", e);
        }
    }

    /** 队列深度（包级可见，测试用）。 */
    int queuedDepth() {
        return queue.size();
    }

    private void drainLoop() {
        while (running || !queue.isEmpty()) {
            Pending pending;
            try {
                pending = queue.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (pending == null) {
                continue;
            }
            try {
                pending.future().complete(service.execute(pending.cmd()));
            } catch (Throwable t) {
                // 连 Error（如 OOM）也不许杀死 worker：异常完整上抛给调用方（5xx→重试），worker 继续存活。
                // worker 全灭 = executor 僵死（每次提交 30s 超时），只剩兜底轮询——宁可多打日志也不能死
                log.error("[PAY] timeout_executor_failed order_no={}", pending.cmd().orderNo(), t);
                pending.future().completeExceptionally(t);
            }
        }
    }

    @PreDestroy
    public void shutdown() {
        running = false;
        for (Thread worker : workers) {
            try {
                worker.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        log.info("[PAY] timeout_execution_queue drained remaining={}", queue.size());
    }
}
