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

/** executor 并发自守：FIFO 顺序消费、队列满快速失败、worker 异常向上传播（5xx→调用方重试）。 */
@ExtendWith(MockitoExtension.class)
class TimeoutExecutionQueueTest {

    @Mock
    private TimeoutExecutionService service;

    private TimeoutExecutionQueue queue;

    private static PayProperties props(int workers, int capacity) {
        return new PayProperties(null, null, null, null, null, null,
                new PayProperties.Job(workers, capacity, 120, 600, 60, 300, 60));
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
            release.await(10, java.util.concurrent.TimeUnit.SECONDS); // 占住唯一 worker
            return ExecuteResult.ok();
        });

        var pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            // 1) worker 被占用（阻塞执行中）；submit 同步等待，须异步发起
            var f1 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-run", 1)));
            firstStarted.await(5, java.util.concurrent.TimeUnit.SECONDS);
            // 2) 连续入队至容量上限（capacity=2），轮询等待（异步提交，不阻塞）
            var f2 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-q1", 1)));
            var f3 = pool.submit(() -> queue.submit(new TimeoutCommand("PO-q2", 1)));
            long deadline = System.currentTimeMillis() + 3000;
            while (queue.queuedDepth() < 2 && System.currentTimeMillis() < deadline) {
                Thread.sleep(20);
            }
            assertThat(queue.queuedDepth()).isEqualTo(2);
            // 3) 第 4 条 → 队列满快速失败
            assertThatThrownBy(() -> queue.submit(new TimeoutCommand("PO-q3", 1)))
                    .isInstanceOf(TimeoutExecutionQueue.QueueFullException.class);
            // 4) 放行 → 队列排空，全部成功
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
        // Error（如 OOM）不许杀死 worker：异常上抛（5xx→重试），worker 继续接活
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
        // 第二次调用正常执行 = worker 存活
        assertThat(queue.submit(new TimeoutCommand("PO2", 1)).executed()).isTrue();
    }
}
