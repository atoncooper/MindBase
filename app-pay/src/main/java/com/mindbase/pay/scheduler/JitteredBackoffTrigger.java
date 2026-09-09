package com.mindbase.pay.scheduler;

import org.springframework.scheduling.Trigger;
import org.springframework.scheduling.TriggerContext;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 随机偏移 + 空跑自适应退避的轮询触发器（plan/1.0.8 §5.4）：
 *   next = last完成 + base × 1.5^连续空跑次数（cap 封顶） × (1 ± jitter)
 * - 首次执行立即触发（重启追补）；
 * - cap == base 表示不退避（如掉单查单要求及时）；
 * - jitter ±30% 防多实例/多任务共振。
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
            return Instant.now(); // 重启/首启立即跑一轮（追补）
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
