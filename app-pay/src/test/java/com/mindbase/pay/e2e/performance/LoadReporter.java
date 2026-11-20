package com.mindbase.pay.e2e.performance;

import org.slf4j.Logger;

import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Formats load-test results into readable sections in the console and
 * logs/app-tests.log.
 *
 * <p>Reporting only; assertions stay in the test class so reports and
 * failures are easy to distinguish.
 */
public final class LoadReporter {

    private static final String SEPARATOR =
            "==========================================================================================";

    private LoadReporter() {
    }

    private static final String SUMMARY_BORDER =
            "+--------------------------+------------------------------+";

    /** Log the phase summary and the latency percentile table. */
    public static void logPhase(Logger log, LoadPhaseResult result) {
        log.info("");
        log.info(SEPARATOR);
        log.info("PERFORMANCE RESULT [{}]", result.phase().toUpperCase(Locale.ROOT));
        log.info("{}", SUMMARY_BORDER);
        log.info("{}", summaryRow("Metric", "Value"));
        log.info("{}", SUMMARY_BORDER);
        log.info("{}", summaryRow("scenario", result.scenario().configValue()));
        log.info("{}", summaryRow("threads", result.threads()));
        log.info("{}", summaryRow("durationSeconds", format("%.1f", result.elapsedSeconds())));
        log.info("{}", summaryRow("requests", result.requests()));
        log.info("{}", summaryRow("successfulRequests", result.successfulRequests()));
        log.info("{}", summaryRow("transactions", result.transactions()));
        log.info("{}", summaryRow("retries", result.retries()));
        log.info("{}", summaryRow("retryRate", format("%.4f", result.retryRate())));
        log.info("{}", summaryRow("QPS", format("%.1f", result.qps())));
        log.info("{}", summaryRow("OPS", format("%.1f", result.ops())));
        log.info("{}", summaryRow("RPS", format("%.1f", result.rps())));
        log.info("{}", summaryRow("TPS", format("%.1f", result.tps())));
        log.info("{}", summaryRow("bytes", result.bytes()));
        log.info("{}", summaryRow("throughputMBps", format("%.2f", result.mbPerSecond())));
        log.info("{}", summaryRow("concurrencyConfigured", result.threads()));
        log.info("{}", summaryRow("concurrencyObserved", result.maxConcurrency()));
        log.info("{}", summaryRow("errorsTotal", result.errors()));
        log.info("{}", summaryRow("errors5xx", result.serverErrors()));
        log.info("{}", summaryRow("errors4xx", result.clientErrors()));
        log.info("{}", summaryRow("timeouts", result.timeouts()));
        log.info("{}", summaryRow("otherErrors", result.otherErrors()));
        log.info("{}", summaryRow("errorRate", format("%.4f", result.errorRate())));
        log.info("{}", summaryRow("successRate", format("%.4f", result.successRate())));
        log.info("{}", summaryRow("timeoutRate", format("%.4f", result.timeoutRate())));
        log.info("{}", summaryRow("availabilityPercent",
                format("%.4f", result.availabilityPercent())));
        log.info("{}", SUMMARY_BORDER);

        log.info("");
        log.info("LATENCY (milliseconds)");
        log.info("{}", latencyHeader());
        for (Map.Entry<String, LatencyDigest> entry : result.endpoints().entrySet()) {
            log.info("{}", latencyRow(entry.getKey(), entry.getValue()));
        }
        log.info("{}", latencyRow("TOTAL", result.overall()));
        log.info(SEPARATOR);
    }

    private static String summaryRow(String key, Object value) {
        return String.format(Locale.ROOT, "| %-24s | %-28s |", key, String.valueOf(value));
    }

    private static String latencyHeader() {
        return String.format(Locale.ROOT,
                "  %-30s %7s %8s %8s %8s %8s %8s %8s %8s %8s %8s %8s %8s",
                "endpoint", "n", "min", "p25", "p50", "p75", "p90", "p95",
                "p99", "p99.9", "p99.99", "max", "avg");
    }

    private static String latencyRow(String endpoint, LatencyDigest digest) {
        return String.format(Locale.ROOT,
                "  %-30s %7d %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f",
                endpoint, digest.size(),
                digest.percentileMs(0.0), digest.percentileMs(0.25),
                digest.percentileMs(0.50), digest.percentileMs(0.75),
                digest.percentileMs(0.90), digest.percentileMs(0.95),
                digest.percentileMs(0.99), digest.percentileMs(0.999),
                digest.percentileMs(0.9999), digest.maxMs(), digest.averageMs());
    }

    /**
     * Log concurrency-ramp results and estimate saturation.
     *
     * <p>Saturation is estimated as the step with the highest RPS whose error
     * rate is within the configured limit.
     */
    public static void logRamp(Logger log, List<LoadPhaseResult> results, double maxErrorRate) {
        log.info("");
        log.info(SEPARATOR);
        log.info("RAMP RESULTS");
        log.info("{}", String.format(Locale.ROOT,
                "  %7s %9s %9s %9s %9s %8s %8s %8s %8s %8s %8s %10s %10s %8s",
                "threads", "requests", "QPS", "OPS", "TPS", "p50", "p95", "p99",
                "p99.9", "p99.99", "max", "errorRate", "timeoutRate", "maxConc"));
        LoadPhaseResult best = null;
        for (LoadPhaseResult result : results) {
            LatencyDigest digest = result.overall();
            log.info("{}", String.format(Locale.ROOT,
                    "  %7d %9d %9.1f %9.1f %9.1f %8.2f %8.2f %8.2f %8.2f %8.2f %8.2f "
                            + "%10.4f %10.4f %8d",
                    result.threads(), result.requests(), result.qps(), result.ops(), result.tps(),
                    digest.percentileMs(0.50), digest.percentileMs(0.95),
                    digest.percentileMs(0.99), digest.percentileMs(0.999),
                    digest.percentileMs(0.9999), digest.maxMs(),
                    result.errorRate(), result.timeoutRate(), result.maxConcurrency()));
            if (result.errorRate() <= maxErrorRate
                    && (best == null || result.rps() > best.rps())) {
                best = result;
            }
        }
        if (best == null) {
            log.warn("saturation: unknown (every step exceeded maxErrorRate={})", maxErrorRate);
        } else {
            LatencyDigest digest = best.overall();
            log.info("saturation: threads={}  QPS={}  OPS={}  TPS={}  p50={}ms  p95={}ms  "
                            + "p99={}ms  p99.9={}ms  p99.99={}ms  maxConcurrency={}",
                    best.threads(), format("%.1f", best.qps()), format("%.1f", best.ops()),
                    format("%.1f", best.tps()),
                    format("%.2f", digest.percentileMs(0.50)),
                    format("%.2f", digest.percentileMs(0.95)),
                    format("%.2f", digest.percentileMs(0.99)),
                    format("%.2f", digest.percentileMs(0.999)),
                    format("%.2f", digest.percentileMs(0.9999)),
                    best.maxConcurrency());
        }
        log.info(SEPARATOR);
    }

    /** Log error aggregation and up to maxLoggedErrors samples. */
    public static void logErrors(Logger log, LoadPhaseResult result) {
        if (result.errors() == 0) {
            log.info("errors: none");
            return;
        }
        log.warn("");
        log.warn(SEPARATOR);
        log.warn("ERRORS [{}]  total={}  5xx={}  4xx={}  timeout={}  other={}",
                result.phase(), result.errors(), result.serverErrors(), result.clientErrors(),
                result.timeouts(), result.otherErrors());
        result.errorBreakdown().forEach((key, count) ->
                log.warn("  breakdown {} = {}", key, count));
        for (LoadPhaseResult.ErrorSample sample : result.errorSamples()) {
            log.warn("  sample endpoint={} category={} status={} elapsedMs={} exception={} body={}",
                    sample.endpoint(), sample.category(), sample.status(),
                    format("%.2f", sample.elapsedMs()), sample.exception(), sample.bodySnippet());
        }
        int logged = result.errorSamples().size();
        if (result.errors() > logged) {
            log.warn("  {} more errors not logged (perf.max-logged-errors={})",
                    result.errors() - logged, logged);
        }
        log.warn(SEPARATOR);
    }

    private static String format(String pattern, double value) {
        return String.format(Locale.ROOT, pattern, value);
    }
}