package com.mindbase.pay.e2e.performance;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable result of one load phase (warmup or measurement).
 *
 * <p>Fields cover latency, throughput, errors/timeouts/retries, and
 * concurrency so the reporter can print a complete picture without
 * re-deriving values from raw samples.
 */
public record LoadPhaseResult(
        String phase,
        PerfScenario scenario,
        int threads,
        double elapsedSeconds,
        long requests,
        long successfulRequests,
        long transactions,
        long retries,
        long errors,
        long serverErrors,
        long clientErrors,
        long timeouts,
        long otherErrors,
        long bytes,
        int maxConcurrency,
        Map<String, LatencyDigest> endpoints,
        Map<String, Long> errorBreakdown,
        List<ErrorSample> errorSamples) {

    /** Merged latency samples across all endpoints. */
    public LatencyDigest overall() {
        LatencyDigest overall = new LatencyDigest();
        endpoints.values().forEach(overall::addAll);
        return overall;
    }

    public double errorRate() {
        return requests == 0 ? 0.0 : (double) errors / requests;
    }

    public double successRate() {
        return requests == 0 ? 0.0 : (double) successfulRequests / requests;
    }

    public double timeoutRate() {
        return requests == 0 ? 0.0 : (double) timeouts / requests;
    }

    /** Availability = successful requests / total requests (percent). */
    public double availabilityPercent() {
        return successRate() * 100.0;
    }

    public double retryRate() {
        return requests == 0 ? 0.0 : (double) retries / requests;
    }

    /** QPS: HTTP requests per second (attempts, including retries). */
    public double qps() {
        return elapsedSeconds <= 0 ? 0.0 : requests / elapsedSeconds;
    }

    /** RPS: alias of QPS for request-oriented reports. */
    public double rps() {
        return qps();
    }

    /** OPS: successful HTTP operations per second (2xx/business-valid). */
    public double ops() {
        return elapsedSeconds <= 0 ? 0.0 : successfulRequests / elapsedSeconds;
    }

    /** Transactions per second (successful logical iterations). */
    public double tps() {
        return elapsedSeconds <= 0 ? 0.0 : transactions / elapsedSeconds;
    }

    public double bytesPerSecond() {
        return elapsedSeconds <= 0 ? 0.0 : bytes / elapsedSeconds;
    }

    public double mbPerSecond() {
        return bytesPerSecond() / 1024.0 / 1024.0;
    }

    public static LoadPhaseResult empty(String phase, PerfScenario scenario, int threads) {
        return new LoadPhaseResult(phase, scenario, threads, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                new LinkedHashMap<>(), new LinkedHashMap<>(), List.of());
    }

    /** One error sample; body is truncated to keep logs bounded. */
    public record ErrorSample(
            String endpoint,
            String category,
            int status,
            String bodySnippet,
            String exception,
            double elapsedMs,
            long atEpochMs) {
    }
}