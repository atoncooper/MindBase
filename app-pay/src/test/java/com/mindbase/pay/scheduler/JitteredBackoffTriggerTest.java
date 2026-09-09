package com.mindbase.pay.scheduler;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.TriggerContext;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/** jitter 边界、空跑退避递进、有工作重置、cap 封顶（jitterRatio=0 时确定性断言）。 */
class JitteredBackoffTriggerTest {

    private static final Instant NOW = Instant.parse("2026-09-06T04:00:00Z");

    private static class FakeJob implements AdaptiveJob {
        private volatile boolean hadWork;

        @Override
        public void run() {
        }

        @Override
        public boolean lastRunHadWork() {
            return hadWork;
        }
    }

    private static TriggerContext ctx(Instant lastCompletion) {
        return new TriggerContext() {
            @Override
            public Instant lastScheduledExecution() {
                return null;
            }

            @Override
            public Instant lastActualExecution() {
                return null;
            }

            @Override
            public Instant lastCompletion() {
                return lastCompletion;
            }
        };
    }

    @Test
    void firstExecutionIsImmediate() {
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                new FakeJob(), Duration.ofSeconds(120), Duration.ofSeconds(600), 0);
        // 空 ctx = 首启/重启，立即追补（对真实时钟断言， NOW 静态常量不可用）
        Instant before = Instant.now();
        Instant next = trigger.nextExecution(ctx(null));
        Instant after = Instant.now();
        assertThat(next).isBetween(before.minusMillis(50), after.plusMillis(50));
    }

    @Test
    void idleStreakBacksOffExponentiallyUpToCap() {
        FakeJob job = new FakeJob();
        job.hadWork = false;
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                job, Duration.ofSeconds(120), Duration.ofSeconds(600), 0);

        Instant last = NOW;
        long[] expected = {180, 270, 405, 600, 600}; // 120×1.5^n，第 4 起触 cap 600
        for (int i = 0; i < expected.length; i++) {
            Instant next = trigger.nextExecution(ctx(last));
            long interval = Duration.between(last, next).getSeconds();
            assertThat(interval).as("第 %d 次空跑后退避间隔", i + 1).isEqualTo(expected[i]);
            last = next;
        }
    }

    @Test
    void findingWorkResetsBackoffToBase() {
        FakeJob job = new FakeJob();
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                job, Duration.ofSeconds(120), Duration.ofSeconds(600), 0);

        job.hadWork = false;
        Instant last = NOW;
        Instant next = trigger.nextExecution(ctx(last)); // 一次空跑 → 180s

        job.hadWork = true;
        Instant afterWork = trigger.nextExecution(ctx(next)); // 发现工作 → 回 base
        assertThat(Duration.between(next, afterWork).getSeconds()).isEqualTo(120);
    }

    @Test
    void capEqualsBaseMeansNoBackoff() {
        FakeJob job = new FakeJob();
        job.hadWork = false;
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                job, Duration.ofSeconds(60), Duration.ofSeconds(60), 0);

        Instant last = NOW;
        for (int i = 0; i < 5; i++) {
            Instant next = trigger.nextExecution(ctx(last));
            assertThat(Duration.between(last, next).getSeconds()).isEqualTo(60);
            last = next;
        }
    }

    @Test
    void jitterStaysWithinRatio() {
        FakeJob job = new FakeJob();
        job.hadWork = true; // 恒 base，无退避，只验 jitter 边界
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                job, Duration.ofSeconds(60), Duration.ofSeconds(60), 0.3);

        Instant last = NOW;
        for (int i = 0; i < 50; i++) {
            Instant next = trigger.nextExecution(ctx(last));
            long interval = Duration.between(last, next).getSeconds();
            assertThat(interval).isBetween(42L, 78L); // 60s ±30%
            last = next;
        }
    }
}
