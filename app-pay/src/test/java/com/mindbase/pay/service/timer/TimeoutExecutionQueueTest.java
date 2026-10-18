package com.mindbase.pay.service.timer;

import com.mindbase.pay.config.PayProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/** Executor concurrency self-defense: FIFO consumption, fail-fast when the queue is full, worker exceptions propagated upward (5xx -> caller retries). */
@ExtendWith(MockitoExtension.class)
class TimeoutExecutionQueueTest {

    @Mock
    private TimeoutExecutionService service;

    private TimeoutExecutionQueue queue;

    private static PayProperties props(int workers, int capacity) {
        return com.mindbase.pay.testutil.TestPayProperties.builder()
                .job(new PayProperties.Job(workers, capacity, 120, 600, 60, 300, 60, 4, 900, 3600, 24, 200))
                .build();
    }

    @AfterEach
    void tearDown() {
        if (queue != null) {
            queue.shutdown();
        }
    }

    @Test
    void submitsExecuteThroughWorkers() {
        queue = new TimeoutExecutionQueue(service, props(2, 10));
        queue.start();
        AtomicInteger executed = new AtomicInteger();
        when(service.execute(any(TimeoutCommand.class))).thenAnswer(inv -> {
            executed.incrementAndGet();
            return ExecuteResult.ok();
        });

        for (int i = 0; i < 5; i++) {
            ExecuteResult result = queue.submit(new TimeoutCommand("PO" + i, 1));
            assertThat(result.executed()).isTrue();
        }
        assertThat(executed.get()).isEqualTo(5);
    }

    @Test
    void queueFullFailsFast() throws Exception {
        queue = new TimeoutExecutionQueue(service, props(1, 2));
        queue.start();
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(service.execute(any(TimeoutCommand.class))).thenAnswer(inv -> {
            firstStarted.countDown();
            release.await(10, java.util.concurrent.TimeUnit.SECONDS); // occupy the only worker
            return ExecuteResult.ok();
        });

        var pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            // 1) worker is occupied (blocking execution); submit waits synchronously, so it must be started asynchronously
            var f1 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-run", 1)));
            firstStarted.await(5, java.util.concurrent.TimeUnit.SECONDS);
            // 2) enqueue up to the capacity limit (capacity=2), polling-wait (submitted asynchronously, no blocking)
            var f2 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-q1", 1)));
            var f3 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-q2", 1)));
            long deadline = System.currentTimeMillis() + 3000;
            while (queue.queuedDepth() < 2 && System.currentTimeMillis() < deadline) {
                Thread.sleep(20);
            }
            assertThat(queue.queuedDepth()).isEqualTo(2);
            // 3) 4th item -> queue full, fail fast
            assertThatThrownBy(() -> queue.submit(new TimeoutCommand("PO-q3", 1)))
                    .isInstanceOf(TimeoutExecutionQueue.QueueFullException.class);
            // 4) release -> queue drains, all succeed
            release.countDown();
            f1.get(5, java.util.concurrent.TimeUnit.SECONDS);
            f2.get(5, java.util.concurrent.TimeUnit.SECONDS);
            f3.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void workerExceptionPropagatesToCaller() {
        queue = new TimeoutExecutionQueue(service, props(1, 10));
        queue.start();
        when(service.execute(any(TimeoutCommand.class)))
                .thenThrow(new RuntimeException("db down"));

        assertThatThrownBy(() -> queue.submit(new TimeoutCommand("PO1", 1)))
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("db down");
    }

    @Test
    void workerSurvivesEvenFatalError() {
        // Error (e.g. OOM) must not kill the worker: the exception is rethrown (5xx -> retry) and the worker keeps taking work
        queue = new TimeoutExecutionQueue(service, props(1, 10));
        queue.start();
        AtomicInteger calls = new AtomicInteger();
        when(service.execute(any(TimeoutCommand.class))).thenAnswer(inv -> {
            if (calls.incrementAndGet() == 1) {
                throw new OutOfMemoryError("boom");
            }
            return ExecuteResult.ok();
        });

        assertThatThrownBy(() -> queue.submit(new TimeoutCommand("PO1", 1)))
                .isInstanceOf(IllegalStateException.class)
                .hasCauseInstanceOf(OutOfMemoryError.class);
        // second call executes normally = worker is alive
        assertThat(queue.submit(new TimeoutCommand("PO2", 1)).executed()).isTrue();
    }
}
