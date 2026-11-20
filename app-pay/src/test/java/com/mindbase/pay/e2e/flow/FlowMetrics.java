package com.mindbase.pay.e2e.flow;

import com.mindbase.pay.e2e.support.PayTestHttpClient;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Lightweight per-operation metrics for the black-box flow suite.
 *
 * <p>Functional tests intentionally call some endpoints expecting 4xx (401/404/409),
 * so 4xx is not "test failure" here; it is reported separately from 5xx/exceptions.
 * The report gives per-API call counts and latency percentiles instead of only
 * pass/fail, so a green suite still shows the behavior and cost of each endpoint.
 */
final class FlowMetrics {

    private final ConcurrentHashMap<String, Operation> operations = new ConcurrentHashMap<>();
    private final AtomicLong totalCalls = new AtomicLong();
    private final AtomicLong total4xx = new AtomicLong();
    private final AtomicLong total5xx = new AtomicLong();
    private final AtomicLong totalExceptions = new AtomicLong();
    private final AtomicLong totalTransactions = new AtomicLong();
    private final Map<String, AtomicLong> transactions = new ConcurrentHashMap<>();
    private final long startedAtNanos = System.nanoTime();

    private static final class Operation {
        private final List<Long> latencies =
                Collections.synchronizedList(new ArrayList<>());
        private final AtomicLong calls = new AtomicLong();
        private final AtomicLong ok2xx = new AtomicLong();
        private final AtomicLong client4xx = new AtomicLong();
        private final AtomicLong server5xx = new AtomicLong();
        private final AtomicLong exceptions = new AtomicLong();
    }

    void record(String operation, PayTestHttpClient.HttpResult result, long latencyNanos) {
        Operation op = operations.computeIfAbsent(operation, key -> new Operation());
        op.calls.incrementAndGet();
        op.latencies.add(latencyNanos);
        totalCalls.incrementAndGet();
        if (result.success()) {
            op.ok2xx.incrementAndGet();
        } else if (result.status() >= 500) {
            op.server5xx.incrementAndGet();
            total5xx.incrementAndGet();
        } else if (result.status() >= 400) {
            op.client4xx.incrementAndGet();
            total4xx.incrementAndGet();
        }
    }

    void exception(String operation, long latencyNanos) {
        Operation op = operations.computeIfAbsent(operation, key -> new Operation());
        op.calls.incrementAndGet();
        op.latencies.add(latencyNanos);
        op.exceptions.incrementAndGet();
        totalCalls.incrementAndGet();
        totalExceptions.incrementAndGet();
    }

    /** Count one successfully completed business transaction (purchase/refund/grant/...). */
    void transaction(String name) {
        totalTransactions.incrementAndGet();
        transactions.computeIfAbsent(name, key -> new AtomicLong()).incrementAndGet();
    }

    private static final String SEPARATOR =
            "==============================================================================================";
    private static final String SUMMARY_BORDER =
            "+------------------------------------+------------------------------+";

    void log(Logger log) {
        double elapsedSeconds = Math.max(0.001,
                TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startedAtNanos));
        long successful = totalCalls.get() - total4xx.get() - total5xx.get()
                - totalExceptions.get();
        long[] allLatencies = overallLatencies();

        log.info("");
        log.info(SEPARATOR);
        log.info("FLOW TEST TOTAL TABLE (single-threaded functional suite)  elapsed={}s",
                format("%.2f", elapsedSeconds));
        log.info("{}", SUMMARY_BORDER);
        log.info("{}", summaryRow("Metric", "Value"));
        log.info("{}", SUMMARY_BORDER);
        log.info("{}", summaryRow("HTTP calls (all)", totalCalls.get()));
        log.info("{}", summaryRow("avg operation latency (ms)",
                format("%.2f", averageMs(allLatencies))));
        log.info("{}", summaryRow("single-thread ceiling (calls/sec)",
                format("%.1f", allLatencies.length == 0 ? 0
                        : 1000.0 / Math.max(0.001, averageMs(allLatencies)))));
        log.info("{}", summaryRow("2xx operations", successful));
        log.info("{}", summaryRow("4xx expected client", total4xx.get()));
        log.info("{}", summaryRow("5xx server errors", total5xx.get()));
        log.info("{}", summaryRow("exceptions", totalExceptions.get()));
        log.info("{}", summaryRow("business transactions", totalTransactions.get()));
        log.info("{}", summaryRow("QPS (suite calls/sec)", format("%.1f",
                totalCalls.get() / elapsedSeconds)));
        log.info("{}", summaryRow("OPS (suite 2xx/sec)", format("%.1f",
                successful / elapsedSeconds)));
        log.info("{}", summaryRow("TPS (suite scenarios/sec)", format("%.2f",
                totalTransactions.get() / elapsedSeconds)));
        log.info("{}", summaryRow("2xx rate", format("%.4f%%",
                totalCalls.get() == 0 ? 0 : successful * 100.0 / totalCalls.get())));
        log.info("{}", SUMMARY_BORDER);
        log.info("NOTE: single-threaded functional suite; QPS/OPS/TPS are suite rates, "
                + "not service capacity. Use PayPerformanceTest for load QPS/TPS.");
        if (!transactions.isEmpty()) {
            log.info("BUSINESS TRANSACTIONS  {}", transactions.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .map(e -> e.getKey() + "=" + e.getValue().get())
                    .reduce((a, b) -> a + "  " + b)
                    .orElse(""));
        }

        log.info("");
        log.info("PER-API METRICS");
        log.info("{}", String.format(Locale.ROOT,
                "  %-34s %6s %5s %5s %5s %5s %9s %9s %9s %9s %9s",
                "operation", "calls", "2xx", "4xx", "5xx", "exc",
                "p50", "p95", "p99", "max", "avg"));
        List<Map.Entry<String, Operation>> entries = new ArrayList<>(operations.entrySet());
        entries.sort(Map.Entry.comparingByKey());
        for (Map.Entry<String, Operation> entry : entries) {
            Operation op = entry.getValue();
            log.info("{}", operationRow(entry.getKey(), op.calls.get(), op.ok2xx.get(),
                    op.client4xx.get(), op.server5xx.get(), op.exceptions.get(),
                    sorted(op.latencies)));
        }
        log.info("{}", operationRow("TOTAL", totalCalls.get(), successful, total4xx.get(),
                total5xx.get(), totalExceptions.get(), allLatencies));
        log.info(SEPARATOR);
    }

    private static String summaryRow(String key, Object value) {
        return String.format(Locale.ROOT, "| %-34s | %-28s |", key, String.valueOf(value));
    }

    private static String operationRow(String operation, long calls, long ok2xx,
                                       long client4xx, long server5xx, long exceptions,
                                       long[] sorted) {
        return String.format(Locale.ROOT,
                "  %-34s %6d %5d %5d %5d %5d %9.2f %9.2f %9.2f %9.2f %9.2f",
                operation, calls, ok2xx, client4xx, server5xx, exceptions,
                percentileMs(sorted, 0.50), percentileMs(sorted, 0.95),
                percentileMs(sorted, 0.99), maxMs(sorted), averageMs(sorted));
    }

    private long[] overallLatencies() {
        List<Long> all = new ArrayList<>();
        for (Operation op : operations.values()) {
            synchronized (op.latencies) {
                all.addAll(op.latencies);
            }
        }
        return all.stream().mapToLong(Long::longValue).sorted().toArray();
    }

    private static long[] sorted(List<Long> latencies) {
        synchronized (latencies) {
            return latencies.stream().mapToLong(Long::longValue).sorted().toArray();
        }
    }

    private static String format(String pattern, double value) {
        return String.format(Locale.ROOT, pattern, value);
    }

    private static double percentileMs(long[] sorted, double percentile) {
        if (sorted.length == 0) {
            return 0;
        }
        int index = (int) Math.ceil(percentile * sorted.length) - 1;
        index = Math.max(0, Math.min(sorted.length - 1, index));
        return sorted[index] / 1_000_000.0;
    }

    private static double maxMs(long[] sorted) {
        return sorted.length == 0 ? 0 : sorted[sorted.length - 1] / 1_000_000.0;
    }

    private static double averageMs(long[] sorted) {
        if (sorted.length == 0) {
            return 0;
        }
        long sum = 0;
        for (long value : sorted) {
            sum += value;
        }
        return sum / (double) sorted.length / 1_000_000.0;
    }
}