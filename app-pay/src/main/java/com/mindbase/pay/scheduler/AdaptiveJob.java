package com.mindbase.pay.scheduler;

/**
 * Periodic job drivable by {@link JitteredBackoffTrigger}: the execution body plus whether the current round had work.
 * hadWork drives idle backoff: consecutive idle rounds stretch the interval, and any work resets it to base.
 */
public interface AdaptiveJob {

    void run();

    /** Whether the round that just finished found work (the basis for backoff/reset). */
    boolean lastRunHadWork();
}
