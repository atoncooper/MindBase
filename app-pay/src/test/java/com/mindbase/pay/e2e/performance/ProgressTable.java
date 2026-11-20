package com.mindbase.pay.e2e.performance;

import org.slf4j.Logger;

import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Live progress table for a load phase.
 *
 * <p>The header is printed once when the phase starts, one row is printed every
 * perf.log-interval-seconds, and the border is printed again when the phase ends.
 * Rates (QPS/OPS/TPS) are calculated over the last interval, not cumulatively,
 * so the table shows the current throughput trend.
 */
final class ProgressTable {

    private static final String BORDER =
            "+----------+-----------+---------+---------+---------+--------+---------+---------+---------+";
    private static final String HEADER = String.format(Locale.ROOT,
            "| %8s | %9s | %7s | %7s | %7s | %6s | %7s | %7s | %7s |",
            "elapsed", "requests", "QPS", "OPS", "TPS", "errors", "timeout", "retries", "maxConc");

    private long lastNanos = System.nanoTime();
    private long lastRequests;
    private long lastSuccessful;
    private long lastTransactions;

    void logHeader(Logger log, String phase, int threads) {
        log.info("");
        log.info("[perf-progress] phase={} threads={}", phase, threads);
        log.info("[perf-progress] {}", BORDER);
        log.info("[perf-progress] {}", HEADER);
        log.info("[perf-progress] {}", BORDER);
    }

    void logRow(Logger log, String phase, long startedNanos,
                long requests, long successful, long transactions,
                long errors, long timeouts, long retries, int maxConcurrency) {
        long now = System.nanoTime();
        double intervalSeconds = Math.max(0.001, (now - lastNanos) / 1_000_000_000.0);
        double qps = (requests - lastRequests) / intervalSeconds;
        double ops = (successful - lastSuccessful) / intervalSeconds;
        double tps = (transactions - lastTransactions) / intervalSeconds;
        long elapsedSeconds = TimeUnit.NANOSECONDS.toSeconds(now - startedNanos);

        log.info("[perf-progress] {}", String.format(Locale.ROOT,
                "| %8d | %9d | %7.1f | %7.1f | %7.1f | %6d | %7d | %7d | %7d |",
                elapsedSeconds, requests, qps, ops, tps, errors, timeouts, retries,
                maxConcurrency));

        lastNanos = now;
        lastRequests = requests;
        lastSuccessful = successful;
        lastTransactions = transactions;
    }

    void logFooter(Logger log) {
        log.info("[perf-progress] {}", BORDER);
    }
}