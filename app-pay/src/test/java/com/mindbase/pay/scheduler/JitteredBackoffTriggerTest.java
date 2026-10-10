package com.mindbase.pay.scheduler;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.TriggerContext;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/** Jitter bounds, escalating backoff on idle runs, reset when work is found, cap ceiling (deterministic assertions when jitterRatio=0). */
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
        // Empty ctx = first start/restart, catch up immediately (assert against the real clock; the static NOW constant is unusable here)
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
        long[] expected = {180, 270, 405, 600, 600}; // 120 * 1.5^n, hits the cap of 600 from the 4th iteration on
        for (int i = 0; i < expected.length; i++) {
            Instant next = trigger.nextExecution(ctx(last));
            long interval = Duration.between(last, next).getSeconds();
            assertThat(interval).as("backoff interval after idle run #%d", i + 1).isEqualTo(expected[i]);
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
        Instant next = trigger.nextExecution(ctx(last)); // one idle run -> 180s

        job.hadWork = true;
        Instant afterWork = trigger.nextExecution(ctx(next)); // work found -> back to base
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
        job.hadWork = true; // always base, no backoff, only verifying jitter bounds
        JitteredBackoffTrigger trigger = new JitteredBackoffTrigger(
                job, Duration.ofSeconds(60), Duration.ofSeconds(60), 0.3);

        Instant last = NOW;
        for (int i = 0; i < 50; i++) {
            Instant next = trigger.nextExecution(ctx(last));
            long interval = Duration.between(last, next).getSeconds();
            assertThat(interval).isBetween(42L, 78L); // 60s +/- 30%
            last = next;
        }
    }
}
