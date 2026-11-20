package com.mindbase.pay.e2e.performance;

import com.mindbase.pay.e2e.support.PayTestConfig;

import java.util.Arrays;

/**
 * 一次压测的不可变参数（来自 pay-test.properties）。
 *
 * <p>集中所有可调参数，测试类只做编排，LoadRunner 只负责执行。
 * 新增指标/场景时优先扩展本 record，不要把参数散落到测试方法里。
 */
public record PerfOptions(
        PerfScenario scenario,
        int threads,
        int warmupSeconds,
        int warmupThreads,
        int durationSeconds,
        int logIntervalSeconds,
        int maxLoggedErrors,
        boolean assertThresholds,
        long p50ThresholdMs,
        long p95ThresholdMs,
        long p99ThresholdMs,
        long p999ThresholdMs,
        long p9999ThresholdMs,
        double minQps,
        double minOps,
        double maxErrorRate,
        double availabilityTarget,
        int minSamples,
        int payloadPaddingBytes,
        int[] rampThreads,
        int rampStepSeconds,
        int maxRetries,
        boolean metricsEnabled,
        int metricsIntervalSeconds,
        int connectionProbeSamples) {

    /** Build and validate options from the global test configuration. */
    public static PerfOptions from(PayTestConfig config) {
        return new PerfOptions(
                PerfScenario.parse(config.perfScenario()),
                config.perfThreads(),
                config.perfWarmupSeconds(),
                config.perfWarmupThreads(),
                config.perfDurationSeconds(),
                config.perfLogIntervalSeconds(),
                config.perfMaxLoggedErrors(),
                config.perfAssertThresholds(),
                config.perfThresholdP50Ms(),
                config.perfThresholdP95Ms(),
                config.perfThresholdP99Ms(),
                config.perfThresholdP999Ms(),
                config.perfThresholdP9999Ms(),
                config.perfMinQps(),
                config.perfMinOps(),
                config.perfMaxErrorRate(),
                config.perfAvailabilityTarget(),
                config.perfMinSamples(),
                config.perfPayloadPaddingBytes(),
                config.perfRampThreads(),
                config.perfRampStepSeconds(),
                config.httpMaxRetries(),
                config.metricsEnabled(),
                config.metricsIntervalSeconds(),
                config.metricsConnectionProbeSamples());
    }

    public boolean rampEnabled() {
        return rampThreads != null && rampThreads.length > 0;
    }

    /** Log effective options (no tokens/secrets) so a run can be reproduced. */
    public void logSummary(org.slf4j.Logger log) {
        log.info("[perf] config scenario={} threads={} warmupSeconds={} warmupThreads={} "
                        + "durationSeconds={} logIntervalSeconds={} maxLoggedErrors={} "
                        + "thresholds p50<= {}ms p95<= {}ms p99<= {}ms p99.9<= {}ms p99.99<= {}ms "
                        + "minQps={} minOps={} maxErrorRate={} availabilityTarget={}% "
                        + "minSamples={} assertThresholds={} "
                        + "payloadPaddingBytes={} rampThreads={} rampStepSeconds={} maxRetries={} "
                        + "metricsEnabled={} metricsIntervalSeconds={} connectionProbeSamples={}",
                scenario.configValue(), threads, warmupSeconds, warmupThreads,
                durationSeconds, logIntervalSeconds, maxLoggedErrors,
                p50ThresholdMs, p95ThresholdMs, p99ThresholdMs, p999ThresholdMs, p9999ThresholdMs,
                minQps, minOps, maxErrorRate, availabilityTarget, minSamples, assertThresholds,
                payloadPaddingBytes, Arrays.toString(rampThreads), rampStepSeconds, maxRetries,
                metricsEnabled, metricsIntervalSeconds, connectionProbeSamples);
    }
}