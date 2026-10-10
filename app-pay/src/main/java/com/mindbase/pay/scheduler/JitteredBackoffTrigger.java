package com.mindbase.pay.scheduler;

import org.springframework.scheduling.Trigger;
import org.springframework.scheduling.TriggerContext;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Polling trigger with random jitter and idle-adaptive backoff (plan/1.0.8 §5.4):
 *   next = last completion + base × 1.5^consecutive idle rounds (capped) × (1 ± jitter)
 * - First execution fires immediately (catch-up after restart);
 * - cap == base means no backoff (e.g. missed-payment queries must be timely);
 * - jitter ±30% prevents resonance across instances/tasks.
 */
public class JitteredBackoffTrigger implements Trigger {

    private static final double BACKOFF_FACTOR = 1.5;

    private final AdaptiveJob job;
    private final Duration base;
    private final Duration cap;
    private final double jitterRatio;
    private final AtomicInteger idleStreak = new AtomicInteger();

    public JitteredBackoffTrigger(AdaptiveJob job, Duration base, Duration cap, double jitterRatio) {
        this.job = job;
        this.base = base;
        this.cap = cap;
        this.jitterRatio = jitterRatio;
    }

    @Override
    public Instant nextExecution(TriggerContext ctx) {
        Instant last = ctx.lastCompletion();
        if (last == null) {
            return Instant.now(); // run one round immediately on restart/first start (catch-up)
        }
        if (job.lastRunHadWork()) {
            idleStreak.set(0);
        } else {
            idleStreak.incrementAndGet();
        }
        long millis = base.toMillis();
        if (cap.compareTo(base) > 0) {
            double factor = Math.pow(BACKOFF_FACTOR, Math.min(idleStreak.get(), 30));
            millis = Math.min((long) (base.toMillis() * factor), cap.toMillis());
        }
        double jitter = jitterRatio > 0
                ? 1 + ThreadLocalRandom.current().nextDouble(-jitterRatio, jitterRatio)
                : 1.0;
        return last.plusMillis((long) (millis * jitter));
    }
}
