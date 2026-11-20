package com.mindbase.pay.e2e.performance;

import com.mindbase.pay.e2e.support.PayTestConfig;
import com.mindbase.pay.e2e.support.PayTestHttpClient;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * app-pay performance test entry point (Java + JUnit, src/test).
 *
 * <p>This class only orchestrates: load config -> warmup -> measure/ramp ->
 * report -> assert. The engine lives in {@link LoadRunner}, latency math in
 * {@link LatencyDigest}, service metrics in {@link ServiceMetricsSampler},
 * connection probes in {@link ConnectionProbe}.
 *
 * <p>Prerequisite: standalone test environment
 * <pre>
 *   cd app-pay
 *   mvn -DskipTests package
 *   docker compose -f docker-compose.test.yml up -d --build
 * </pre>
 *
 * <p>Run (perf is disabled by default):
 * <pre>
 *   # edit src/test/resources/pay-test.properties:
 *   #   perf.enabled=true
 *   #   perf.scenario=read
 *   #   perf.threads=20
 *   #   perf.duration-seconds=120
 *   mvn test -Dtest=PayPerformanceTest
 * </pre>
 *
 * <p>Ramp mode for saturation: set {@code perf.ramp-threads=10,20,50,100} and
 * {@code perf.ramp-step-seconds=15}; the report logs per-step RPS/TPS/latency
 * and a saturation estimate.
 */
@DisplayName("app-pay performance test (Java: latency percentiles, RPS/TPS, errors, system metrics)")
class PayPerformanceTest {

    private static final Logger log = LoggerFactory.getLogger(PayPerformanceTest.class);

    private static PayTestConfig config;
    private static PayTestHttpClient http;

    @BeforeAll
    static void setUp() {
        // Only load config here; skip decisions are made inside the test method so
        // IntelliJ reports a skipped test (exit code 0) instead of aborting the class.
        config = PayTestConfig.load();
        log.info("[perf] test log file: logs/app-tests.log (relative to app-pay)");
        log.info("[perf] test config baseUrl={} testEnabled={} perfEnabled={}",
                config.baseUrl(), config.testEnabled(), config.perfEnabled());
    }

    @AfterAll
    static void tearDown() {
        if (http != null) {
            http.close();
        }
    }

    @Test
    @DisplayName("run configured load test and report full latency/throughput/error/system metrics")
    void runConfiguredLoad() {
        if (!config.testEnabled()) {
            log.warn("[perf] SKIP: pay.test.enabled=false (remote test master switch is off)");
        }
        if (!config.perfEnabled()) {
            log.warn("[perf] SKIP: perf.enabled=false; set perf.enabled=true in "
                    + "src/test/resources/pay-test.properties and rerun");
        }
        Assumptions.assumeTrue(config.testEnabled(),
                "pay.test.enabled=false; skipping performance test");
        Assumptions.assumeTrue(config.perfEnabled(),
                "perf.enabled=false; set perf.enabled=true in "
                        + "src/test/resources/pay-test.properties and rerun");

        PerfOptions options = PerfOptions.from(config);
        options.logSummary(log);

        http = new PayTestHttpClient(config);
        boolean healthy = http.healthy();
        if (!healthy) {
            log.error("[perf] app-pay unreachable baseUrl={}; start it with "
                    + "docker compose -f docker-compose.test.yml up -d", config.baseUrl());
        }
        Assumptions.assumeTrue(healthy, "app-pay test environment is not running: " + config.baseUrl());

        log.info("[perf] ===== app-pay performance test START =====");
        LoadRunner runner = new LoadRunner(http, options);

        // Fresh TCP/TLS connection cost is measured before keep-alive reuse kicks in.
        ConnectionProbe.probe(config, options.connectionProbeSamples()).log(log);

        if (options.warmupSeconds() > 0) {
            log.info("[perf] warmup start threads={} durationSeconds={}",
                    options.warmupThreads(), options.warmupSeconds());
            LoadPhaseResult warmup = runner.warmup();
            log.info("[perf] warmup finished requests={} errors={} errorRate={} rps={}",
                    warmup.requests(), warmup.errors(),
                    format("%.4f", warmup.errorRate()), format("%.1f", warmup.rps()));
            LoadReporter.logErrors(log, warmup);
        }

        if (options.rampEnabled()) {
            runRamp(runner, options);
        } else {
            runSingle(runner, options);
        }

        log.info("[perf] ===== app-pay performance test PASS =====");
    }

    /** Single-concurrency measurement with full assertions. */
    private void runSingle(LoadRunner runner, PerfOptions options) {
        log.info("[perf] measure start threads={} durationSeconds={}",
                options.threads(), options.durationSeconds());
        ServiceMetricsSampler sampler = new ServiceMetricsSampler(http, config);
        sampler.start();
        LoadPhaseResult result;
        try {
            result = runner.measure();
        } finally {
            sampler.stop().log(log);
        }
        LoadReporter.logPhase(log, result);
        LoadReporter.logErrors(log, result);
        assertResult("single", result, options);
    }

    /** Concurrency ramp for saturation estimation; thresholds are reported, error rate is enforced. */
    private void runRamp(LoadRunner runner, PerfOptions options) {
        log.info("[perf] ramp start threads={} stepSeconds={}",
                java.util.Arrays.toString(options.rampThreads()), options.rampStepSeconds());
        List<LoadPhaseResult> steps = new ArrayList<>();
        for (int threads : options.rampThreads()) {
            log.info("[perf] ramp step start threads={} durationSeconds={}",
                    threads, options.rampStepSeconds());
            ServiceMetricsSampler sampler = new ServiceMetricsSampler(http, config);
            sampler.start();
            LoadPhaseResult result;
            try {
                result = runner.measure(threads, options.rampStepSeconds());
            } finally {
                sampler.stop().log(log);
            }
            LoadReporter.logPhase(log, result);
            LoadReporter.logErrors(log, result);
            assertErrorRate("ramp threads=" + threads, result, options);
            steps.add(result);
        }
        LoadReporter.logRamp(log, steps, options.maxErrorRate());
        log.info("[perf] ramp note: thresholds are not asserted in ramp mode; "
                + "use the saturation estimate and per-step latency to choose capacity");
    }

    /** Full assertions for a single measurement. */
    private void assertResult(String label, LoadPhaseResult result, PerfOptions options) {
        if (result.requests() == 0) {
            log.error("[perf] FAIL [{}]: no requests were sent", label);
        }
        assertThat(result.requests())
                .as("%s: measurement requests must be > 0", label)
                .isPositive();
        assertErrorRate(label, result, options);

        LatencyDigest overall = result.overall();
        assertThat(overall.size())
                .as("%s: valid latency samples must be > 0", label)
                .isPositive();
        if (overall.size() < options.minSamples()) {
            log.warn("[perf] WARN [{}]: validSamples={} < minSamples={}; "
                            + "p99.9/p99.99 may be unstable, increase durationSeconds/threads",
                    label, overall.size(), options.minSamples());
        }

        if (options.minQps() > 0) {
            if (result.qps() < options.minQps()) {
                log.error("[perf] FAIL [{}]: qps={} < minQps={}",
                        label, format("%.1f", result.qps()), options.minQps());
            }
            assertThat(result.qps())
                    .as("%s: qps %s is below minQps %s", label,
                            format("%.1f", result.qps()), options.minQps())
                    .isGreaterThanOrEqualTo(options.minQps());
        }
        if (options.minOps() > 0) {
            if (result.ops() < options.minOps()) {
                log.error("[perf] FAIL [{}]: ops={} < minOps={}",
                        label, format("%.1f", result.ops()), options.minOps());
            }
            assertThat(result.ops())
                    .as("%s: ops %s is below minOps %s", label,
                            format("%.1f", result.ops()), options.minOps())
                    .isGreaterThanOrEqualTo(options.minOps());
        }

        if (options.availabilityTarget() > 0) {
            double availability = result.availabilityPercent();
            if (availability < options.availabilityTarget()) {
                log.error("[perf] FAIL [{}]: availability={}% < target={}%",
                        label, format("%.4f", availability), options.availabilityTarget());
            }
            assertThat(availability)
                    .as("%s: availability %s%% is below target %s%%",
                            label, format("%.4f", availability), options.availabilityTarget())
                    .isGreaterThanOrEqualTo(options.availabilityTarget());
        }

        if (options.assertThresholds()) {
            assertThreshold("p50", overall.percentileMs(0.50), options.p50ThresholdMs());
            assertThreshold("p95", overall.percentileMs(0.95), options.p95ThresholdMs());
            assertThreshold("p99", overall.percentileMs(0.99), options.p99ThresholdMs());
            assertThreshold("p99.9", overall.percentileMs(0.999), options.p999ThresholdMs());
            assertThreshold("p99.99", overall.percentileMs(0.9999), options.p9999ThresholdMs());
        } else {
            log.warn("[perf] assertThresholds=false; report only, thresholds are not enforced");
        }
    }

    private void assertErrorRate(String label, LoadPhaseResult result, PerfOptions options) {
        double errorRate = result.errorRate();
        if (errorRate > options.maxErrorRate()) {
            log.error("[perf] FAIL [{}]: errorRate={} exceeds maxErrorRate={} requests={} errors={}",
                    label, format("%.4f", errorRate), options.maxErrorRate(),
                    result.requests(), result.errors());
        }
        assertThat(errorRate)
                .as("%s: error rate %s exceeds limit %s (requests=%d errors=%d)",
                        label, format("%.4f", errorRate), options.maxErrorRate(),
                        result.requests(), result.errors())
                .isLessThanOrEqualTo(options.maxErrorRate());
    }

    /** Log FAIL first, then let JUnit assert; both report and failure are visible. */
    private void assertThreshold(String name, double actualMs, long thresholdMs) {
        if (thresholdMs <= 0) {
            log.info("[perf] threshold {} disabled (0)", name);
            return;
        }
        if (actualMs > thresholdMs) {
            log.error("[perf] FAIL: {}={}ms > threshold={}ms", name,
                    format("%.2f", actualMs), thresholdMs);
        }
        assertThat(actualMs)
                .as("%s=%sms exceeds threshold %dms (tune perf.threshold-%s-ms or investigate)",
                        name, format("%.2f", actualMs), thresholdMs, name)
                .isLessThanOrEqualTo((double) thresholdMs);
    }

    private static String format(String pattern, double value) {
        return String.format(java.util.Locale.ROOT, pattern, value);
    }
}