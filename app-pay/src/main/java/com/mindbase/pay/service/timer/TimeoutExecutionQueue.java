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
 * Concurrency self-limits for timeout execution (plan/1.0.8 §5.3): the executor endpoint performs no DB
 * operation; commands enter a local bounded FIFO and are consumed in parallel by a fixed worker pool --
 * in-flight DB UPDATEs are always <= workers, fully independent of the caller's (app-task) dispatch
 * behavior.
 *
 * Backpressure: queue full -> {@link QueueFullException} -> endpoint 503 -> app-task's existing
 * exponential backoff retry. Crash semantics: the in-memory queue is an optimization, not correctness -- a
 * crash drops queued commands and fallback polling inevitably takes over; graceful shutdown drains the
 * queue. Worker count is anchored to the DB connection pool (Hikari 10 -> default 8).
 */
@Slf4j
@Component
public class TimeoutExecutionQueue {

    /** Queue full: the endpoint returns 503 and the caller retries with backoff. */
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

    /** Enqueue and wait for this command to finish (synchronous semantics, so app-task's completed stays truthful). */
    public ExecuteResult submit(TimeoutCommand cmd) {
        CompletableFuture<ExecuteResult> future = new CompletableFuture<>();
        if (!queue.offer(new Pending(cmd, future))) {
            throw new QueueFullException();
        }
        try {
            return future.get(30, TimeUnit.SECONDS); // fallback for a stuck worker: on timeout throw as an exception -> 5xx -> caller retries
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting executor", e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;   // 500 semantics: app-task retries with backoff; the conditional update's idempotency makes it safe
            }
            throw new IllegalStateException(e.getCause());
        } catch (TimeoutException e) {
            throw new IllegalStateException("executor wait timeout", e);
        }
    }

    /** Queue depth (package-visible, for tests). */
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
                // Even an Error (e.g. OOM) must not kill the worker: the exception is propagated to the
                // caller (5xx -> retry) and the worker stays alive.
                // All workers dead = executor hang (every submit waits 30s then times out), leaving only
                // fallback polling -- better to log more than to die
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
