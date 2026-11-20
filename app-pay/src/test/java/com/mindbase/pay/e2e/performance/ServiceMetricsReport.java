package com.mindbase.pay.e2e.performance;

import org.slf4j.Logger;

import java.util.Locale;

/**
 * Service-side metrics collected from actuator/Prometheus during a load phase.
 *
 * <p>Available from Spring Boot actuator: CPU, heap, GC, Hikari pool, Tomcat
 * threads/connections. Network/disk metrics are not exposed by actuator by
 * default; when a node_exporter-style metric set is present it is reported,
 * otherwise a note points to external monitoring.
 */
public record ServiceMetricsReport(
        boolean available,
        String note,
        double elapsedSeconds,
        double cpuSystemAvgPct,
        double cpuSystemMaxPct,
        double cpuProcessAvgPct,
        double cpuProcessMaxPct,
        double load1Avg,
        double load1Max,
        double heapUsedAvgMb,
        double heapUsedMaxMb,
        double heapMaxMb,
        double heapUsedMaxPct,
        long gcCount,
        double gcPauseTotalMs,
        double gcPauseAvgMs,
        double gcPauseMaxMs,
        double gcAllocatedMb,
        double gcPromotedMb,
        double hikariActiveAvg,
        int hikariActiveMax,
        double hikariIdleAvg,
        int hikariPendingMax,
        int hikariMax,
        long acquireCount,
        double acquireTotalMs,
        double acquireAvgMs,
        double acquireMaxMs,
        int tomcatBusyMax,
        int tomcatCurrentMax,
        int tomcatConfigMax,
        int tomcatConnectionsMax,
        boolean networkDiskAvailable,
        double networkRxBytesPerSec,
        double networkTxBytesPerSec,
        double diskReadBytesPerSec,
        double diskWriteBytesPerSec,
        double diskIoUtilizationPct) {

    public static ServiceMetricsReport unavailable(String reason) {
        return new ServiceMetricsReport(
                false, reason,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                0L, 0.0, 0.0, 0.0, 0.0, 0.0,
                0.0, 0, 0.0, 0, 0, 0L, 0.0, 0.0, 0.0,
                0, 0, 0, 0,
                false, 0.0, 0.0, 0.0, 0.0, 0.0);
    }

    private static final String METRIC_BORDER =
            "+------------------------------+----------------------------------------+";

    public void log(Logger log) {
        if (!available) {
            log.warn("[perf][metrics] unavailable: {}", note);
            return;
        }
        log.info("");
        log.info("SYSTEM METRICS  duration={}s", format("%.1f", elapsedSeconds));
        log.info("{}", METRIC_BORDER);
        log.info("{}", metricRow("Metric", "Value"));
        log.info("{}", METRIC_BORDER);
        log.info("{}", metricRow("cpu.system.avgPct", format("%.1f", cpuSystemAvgPct)));
        log.info("{}", metricRow("cpu.system.maxPct", format("%.1f", cpuSystemMaxPct)));
        log.info("{}", metricRow("cpu.process.avgPct", format("%.1f", cpuProcessAvgPct)));
        log.info("{}", metricRow("cpu.process.maxPct", format("%.1f", cpuProcessMaxPct)));
        log.info("{}", metricRow("load1.avg", format("%.2f", load1Avg)));
        log.info("{}", metricRow("load1.max", format("%.2f", load1Max)));
        log.info("{}", metricRow("heap.usedAvgMb", format("%.1f", heapUsedAvgMb)));
        log.info("{}", metricRow("heap.usedMaxMb", format("%.1f", heapUsedMaxMb)));
        log.info("{}", metricRow("heap.maxMb", format("%.1f", heapMaxMb)));
        log.info("{}", metricRow("heap.usedMaxPct", format("%.1f", heapUsedMaxPct)));
        log.info("{}", metricRow("gc.count", gcCount));
        log.info("{}", metricRow("gc.pauseTotalMs", format("%.1f", gcPauseTotalMs)));
        log.info("{}", metricRow("gc.pauseAvgMs", format("%.2f", gcPauseAvgMs)));
        log.info("{}", metricRow("gc.pauseMaxMs", format("%.2f", gcPauseMaxMs)));
        log.info("{}", metricRow("gc.allocatedMb", format("%.1f", gcAllocatedMb)));
        log.info("{}", metricRow("gc.promotedMb", format("%.1f", gcPromotedMb)));
        log.info("{}", metricRow("hikari.activeAvg", format("%.1f", hikariActiveAvg)));
        log.info("{}", metricRow("hikari.activeMax", hikariActiveMax));
        log.info("{}", metricRow("hikari.idleAvg", format("%.1f", hikariIdleAvg)));
        log.info("{}", metricRow("hikari.pendingMax", hikariPendingMax));
        log.info("{}", metricRow("hikari.max", hikariMax));
        log.info("{}", metricRow("hikari.acquireCount", acquireCount));
        log.info("{}", metricRow("hikari.acquireTotalMs", format("%.1f", acquireTotalMs)));
        log.info("{}", metricRow("hikari.acquireAvgMs", format("%.2f", acquireAvgMs)));
        log.info("{}", metricRow("hikari.acquireMaxMs", format("%.2f", acquireMaxMs)));
        log.info("{}", metricRow("tomcat.busyMax", tomcatBusyMax));
        log.info("{}", metricRow("tomcat.currentMax", tomcatCurrentMax));
        log.info("{}", metricRow("tomcat.configMax", tomcatConfigMax));
        log.info("{}", metricRow("tomcat.connectionsMax", tomcatConnectionsMax));
        if (networkDiskAvailable) {
            log.info("{}", metricRow("network.rxMBps",
                    format("%.2f", networkRxBytesPerSec / 1024 / 1024)));
            log.info("{}", metricRow("network.txMBps",
                    format("%.2f", networkTxBytesPerSec / 1024 / 1024)));
            log.info("{}", metricRow("disk.readMBps",
                    format("%.2f", diskReadBytesPerSec / 1024 / 1024)));
            log.info("{}", metricRow("disk.writeMBps",
                    format("%.2f", diskWriteBytesPerSec / 1024 / 1024)));
            log.info("{}", metricRow("disk.ioUtilPct",
                    format("%.1f", diskIoUtilizationPct)));
        } else {
            log.info("{}", metricRow("network.disk", "unavailable: " + note));
        }
        log.info("{}", METRIC_BORDER);
    }

    private static String metricRow(String key, Object value) {
        return String.format(Locale.ROOT, "| %-28s | %-38s |", key, String.valueOf(value));
    }

    private static String format(String pattern, double value) {
        return String.format(Locale.ROOT, pattern, value);
    }
}