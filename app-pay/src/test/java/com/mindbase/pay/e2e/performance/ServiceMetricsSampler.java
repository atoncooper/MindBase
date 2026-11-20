package com.mindbase.pay.e2e.performance;

import com.mindbase.pay.e2e.support.PayTestConfig;
import com.mindbase.pay.e2e.support.PayTestHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Samples service-side metrics from Spring Boot actuator/Prometheus during a
 * load phase.
 *
 * <p>Collected metrics:
 * <ul>
 *   <li>CPU: system/process usage, 1m load average;</li>
 *   <li>memory: heap used/max;</li>
 *   <li>GC: pause count/total/avg/max, allocated/promoted bytes;</li>
 *   <li>Hikari: active/idle/pending/max, acquire count/sum/max (queue wait);</li>
 *   <li>Tomcat: busy/current/config-max threads, current connections
 *       (requires server.tomcat.mbeanregistry.enabled=true);</li>
 *   <li>network/disk: only if node_exporter-style metrics are present.</li>
 * </ul>
 *
 * <p>The scrape uses its own HTTP calls through the shared test client, so it
 * does not affect request latency samples. Metrics failures are logged once and
 * never fail the load test.
 */
public final class ServiceMetricsSampler implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(ServiceMetricsSampler.class);

    private static final String PROMETHEUS_PATH = "/actuator/prometheus";

    private final PayTestHttpClient http;
    private final PayTestConfig config;
    private final List<Snapshot> snapshots = Collections.synchronizedList(new ArrayList<>());
    private final AtomicBoolean failureLogged = new AtomicBoolean();

    private ScheduledExecutorService scheduler;
    private Snapshot baseline;
    private long startedAtNanos;
    private String failureReason;

    public ServiceMetricsSampler(PayTestHttpClient http, PayTestConfig config) {
        this.http = http;
        this.config = config;
    }

    /** Start sampling (no-op when metrics.enabled=false). */
    public void start() {
        if (!config.metricsEnabled()) {
            failureReason = "metrics.enabled=false";
            return;
        }
        startedAtNanos = System.nanoTime();
        baseline = scrape();
        if (baseline == null) {
            failureReason = "failed to scrape " + PROMETHEUS_PATH;
            return;
        }
        snapshots.add(baseline);
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "pay-metrics-sampler");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.scheduleAtFixedRate(() -> {
            Snapshot snapshot = scrape();
            if (snapshot != null) {
                snapshots.add(snapshot);
            }
        }, config.metricsIntervalSeconds(), config.metricsIntervalSeconds(), TimeUnit.SECONDS);
        log.info("[perf][metrics] sampler started intervalSeconds={}", config.metricsIntervalSeconds());
    }

    /** Stop sampling and build the report. */
    public ServiceMetricsReport stop() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
        if (!config.metricsEnabled()) {
            return ServiceMetricsReport.unavailable("metrics.enabled=false");
        }
        Snapshot last = scrape();
        if (last != null) {
            snapshots.add(last);
        }
        List<Snapshot> copy;
        synchronized (snapshots) {
            copy = new ArrayList<>(snapshots);
        }
        if (copy.size() < 2) {
            return ServiceMetricsReport.unavailable(
                    failureReason == null ? "not enough metric samples" : failureReason);
        }
        ServiceMetricsReport report = buildReport(copy);
        log.info("[perf][metrics] sampler stopped samples={}", copy.size());
        return report;
    }

    @Override
    public void close() {
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    // ==================== scraping/parsing ====================

    private Snapshot scrape() {
        try {
            PayTestHttpClient.HttpResult result = http.get(PROMETHEUS_PATH, Map.of());
            if (!result.success()) {
                logOnce("prometheus scrape returned status=" + result.status());
                return null;
            }
            List<MetricSample> samples = parse(result.bodyOrEmpty());
            if (samples.isEmpty()) {
                logOnce("prometheus response contained no metric samples");
                return null;
            }
            return new Snapshot(System.nanoTime(), samples);
        } catch (Exception e) {
            logOnce("prometheus scrape failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return null;
        }
    }

    private void logOnce(String message) {
        if (failureLogged.compareAndSet(false, true)) {
            log.warn("[perf][metrics] {}", message);
        }
    }

    private static List<MetricSample> parse(String body) {
        List<MetricSample> samples = new ArrayList<>();
        for (String rawLine : body.split("\\R")) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int brace = line.indexOf('{');
            int close = brace >= 0 ? line.indexOf('}', brace) : -1;
            String name;
            String tagsPart = "";
            String valuePart;
            if (brace >= 0 && close > brace) {
                name = line.substring(0, brace);
                tagsPart = line.substring(brace + 1, close);
                valuePart = line.substring(close + 1).trim();
            } else {
                int lastSpace = line.lastIndexOf(' ');
                if (lastSpace <= 0) {
                    continue;
                }
                name = line.substring(0, lastSpace);
                valuePart = line.substring(lastSpace + 1).trim();
            }
            try {
                double value = Double.parseDouble(valuePart);
                if (!Double.isFinite(value)) {
                    continue;
                }
                samples.add(new MetricSample(name, parseTags(tagsPart), value));
            } catch (NumberFormatException ignored) {
                // ignore non-numeric exposition lines (e.g. exemplars)
            }
        }
        return samples;
    }

    private static Map<String, String> parseTags(String tagsPart) {
        Map<String, String> tags = new LinkedHashMap<>();
        if (tagsPart == null || tagsPart.isBlank()) {
            return tags;
        }
        java.util.regex.Matcher matcher =
                java.util.regex.Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)=\"([^\"]*)\"")
                        .matcher(tagsPart);
        while (matcher.find()) {
            tags.put(matcher.group(1), matcher.group(2));
        }
        return tags;
    }

    // ==================== report building ====================

    private ServiceMetricsReport buildReport(List<Snapshot> samples) {
        Snapshot first = samples.get(0);
        Snapshot last = samples.get(samples.size() - 1);
        double elapsedSeconds = Math.max(0.001,
                TimeUnit.NANOSECONDS.toSeconds(last.atNanos() - first.atNanos()));

        double cpuSystemAvg = averageGauge(samples, "system_cpu_usage") * 100.0;
        double cpuSystemMax = maxGauge(samples, "system_cpu_usage") * 100.0;
        double cpuProcessAvg = averageGauge(samples, "process_cpu_usage") * 100.0;
        double cpuProcessMax = maxGauge(samples, "process_cpu_usage") * 100.0;
        double loadAvg = averageGauge(samples, "system_load_average_1m");
        double loadMax = maxGauge(samples, "system_load_average_1m");

        double heapUsedAvg = averageHeapUsedMb(samples);
        double heapUsedMax = maxHeapUsedMb(samples);
        double heapMax = last.maxPositive("jvm_memory_max_bytes", "area", "heap") / 1024 / 1024;
        double heapUsedMaxPct = heapMax <= 0 ? 0 : heapUsedMax / heapMax * 100;

        long gcCount = Math.max(0, Math.round(last.sum("jvm_gc_pause_seconds_count")
                - first.sum("jvm_gc_pause_seconds_count")));
        double gcPauseTotalMs = Math.max(0,
                (last.sum("jvm_gc_pause_seconds_sum") - first.sum("jvm_gc_pause_seconds_sum")) * 1000);
        double gcPauseAvgMs = gcCount == 0 ? 0 : gcPauseTotalMs / gcCount;
        double gcPauseMaxMs = maxGauge(samples, "jvm_gc_pause_seconds_max") * 1000;
        double gcAllocatedMb = Math.max(0,
                (last.sum("jvm_gc_memory_allocated_bytes_total")
                        - first.sum("jvm_gc_memory_allocated_bytes_total")) / 1024 / 1024);
        double gcPromotedMb = Math.max(0,
                (last.sum("jvm_gc_memory_promoted_bytes_total")
                        - first.sum("jvm_gc_memory_promoted_bytes_total")) / 1024 / 1024);

        double hikariActiveAvg = averageGauge(samples, "hikaricp_connections_active");
        int hikariActiveMax = (int) Math.round(maxGauge(samples, "hikaricp_connections_active"));
        double hikariIdleAvg = averageGauge(samples, "hikaricp_connections_idle");
        int hikariPendingMax = (int) Math.round(maxGauge(samples, "hikaricp_connections_pending"));
        int hikariMax = (int) Math.round(last.gauge("hikaricp_connections_max"));
        long acquireCount = Math.max(0, Math.round(last.sum("hikaricp_connections_acquire_seconds_count")
                - first.sum("hikaricp_connections_acquire_seconds_count")));
        double acquireTotalMs = Math.max(0,
                (last.sum("hikaricp_connections_acquire_seconds_sum")
                        - first.sum("hikaricp_connections_acquire_seconds_sum")) * 1000);
        double acquireAvgMs = acquireCount == 0 ? 0 : acquireTotalMs / acquireCount;
        double acquireMaxMs = maxGauge(samples, "hikaricp_connections_acquire_seconds_max") * 1000;

        int tomcatBusyMax = (int) Math.round(maxGauge(samples, "tomcat_threads_busy_threads"));
        int tomcatCurrentMax = (int) Math.round(maxGauge(samples, "tomcat_threads_current_threads"));
        int tomcatConfigMax = (int) Math.round(last.gauge("tomcat_threads_config_max_threads"));
        int tomcatConnectionsMax = (int) Math.round(maxGauge(samples, "tomcat_connections_current_connections"));

        boolean networkAvailable = hasMetric(samples, "node_network_receive_bytes_total")
                || hasMetric(samples, "node_disk_read_bytes_total");
        double rx = 0;
        double tx = 0;
        double diskRead = 0;
        double diskWrite = 0;
        double diskIoUtil = 0;
        if (networkAvailable) {
            rx = Math.max(0, last.sum("node_network_receive_bytes_total")
                    - first.sum("node_network_receive_bytes_total")) / elapsedSeconds;
            tx = Math.max(0, last.sum("node_network_transmit_bytes_total")
                    - first.sum("node_network_transmit_bytes_total")) / elapsedSeconds;
            diskRead = Math.max(0, last.sum("node_disk_read_bytes_total")
                    - first.sum("node_disk_read_bytes_total")) / elapsedSeconds;
            diskWrite = Math.max(0, last.sum("node_disk_written_bytes_total")
                    - first.sum("node_disk_written_bytes_total")) / elapsedSeconds;
            double ioSeconds = Math.max(0, last.sum("node_disk_io_time_seconds_total")
                    - first.sum("node_disk_io_time_seconds_total"));
            diskIoUtil = elapsedSeconds <= 0 ? 0 : ioSeconds / elapsedSeconds * 100;
        }
        String note = networkAvailable ? "node_exporter metrics detected"
                : "network/disk metrics are not exposed by actuator; use node_exporter or docker stats";

        return new ServiceMetricsReport(true, note, elapsedSeconds,
                cpuSystemAvg, cpuSystemMax, cpuProcessAvg, cpuProcessMax, loadAvg, loadMax,
                heapUsedAvg, heapUsedMax, heapMax, heapUsedMaxPct,
                gcCount, gcPauseTotalMs, gcPauseAvgMs, gcPauseMaxMs, gcAllocatedMb, gcPromotedMb,
                hikariActiveAvg, hikariActiveMax, hikariIdleAvg, hikariPendingMax, hikariMax,
                acquireCount, acquireTotalMs, acquireAvgMs, acquireMaxMs,
                tomcatBusyMax, tomcatCurrentMax, tomcatConfigMax, tomcatConnectionsMax,
                networkAvailable, rx, tx, diskRead, diskWrite, diskIoUtil);
    }

    private static double averageGauge(List<Snapshot> samples, String metric) {
        double sum = 0;
        int count = 0;
        for (Snapshot snapshot : samples) {
            if (snapshot.has(metric)) {
                sum += snapshot.sum(metric);
                count++;
            }
        }
        return count == 0 ? 0 : sum / count;
    }

    private static double maxGauge(List<Snapshot> samples, String metric) {
        double max = 0;
        for (Snapshot snapshot : samples) {
            max = Math.max(max, snapshot.max(metric));
        }
        return max;
    }

    private static boolean hasMetric(List<Snapshot> samples, String metric) {
        return samples.stream().anyMatch(snapshot -> snapshot.has(metric));
    }

    private static double averageHeapUsedMb(List<Snapshot> samples) {
        double sum = 0;
        int count = 0;
        for (Snapshot snapshot : samples) {
            if (snapshot.has("jvm_memory_used_bytes")) {
                sum += snapshot.sumWhere("jvm_memory_used_bytes", "area", "heap") / 1024 / 1024;
                count++;
            }
        }
        return count == 0 ? 0 : sum / count;
    }

    private static double maxHeapUsedMb(List<Snapshot> samples) {
        double max = 0;
        for (Snapshot snapshot : samples) {
            max = Math.max(max, snapshot.sumWhere("jvm_memory_used_bytes", "area", "heap") / 1024 / 1024);
        }
        return max;
    }

    // ==================== model ====================

    private record MetricSample(String name, Map<String, String> tags, double value) {
    }

    private record Snapshot(long atNanos, List<MetricSample> samples) {

        private boolean has(String metric) {
            return samples.stream().anyMatch(sample -> sample.name().equals(metric));
        }

        private double sum(String metric) {
            return samples.stream()
                    .filter(sample -> sample.name().equals(metric))
                    .mapToDouble(MetricSample::value)
                    .sum();
        }

        private double max(String metric) {
            return samples.stream()
                    .filter(sample -> sample.name().equals(metric))
                    .mapToDouble(MetricSample::value)
                    .max()
                    .orElse(0);
        }

        private double gauge(String metric) {
            return sum(metric);
        }

        private double sumWhere(String metric, String tagKey, String tagValue) {
            return samples.stream()
                    .filter(sample -> sample.name().equals(metric))
                    .filter(sample -> tagValue.equals(sample.tags().get(tagKey)))
                    .mapToDouble(MetricSample::value)
                    .sum();
        }

        private double maxPositive(String metric, String tagKey, String tagValue) {
            return samples.stream()
                    .filter(sample -> sample.name().equals(metric))
                    .filter(sample -> tagValue.equals(sample.tags().get(tagKey)))
                    .mapToDouble(MetricSample::value)
                    .filter(value -> value > 0)
                    .sum();
        }
    }
}