package com.mindbase.pay.e2e.performance;

import com.mindbase.pay.e2e.support.PayTestHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.http.HttpTimeoutException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Predicate;

/**
 * Load-test engine, independent from JUnit.
 *
 * <p>Responsibilities:
 * <ul>
 *   <li>worker pool, progress logs, latency sampling, error classification;</li>
 *   <li>RPS vs TPS: RPS counts HTTP attempts, TPS counts successful logical iterations;</li>
 *   <li>throughput bytes, retries, timeout/4xx/5xx split, observed concurrency;</li>
 *   <li>optional per-request retry on connection/timeout errors (http.max-retries).</li>
 * </ul>
 *
 * <p>System metrics (CPU/heap/GC/Hikari/Tomcat) are collected separately by
 * {@link ServiceMetricsSampler} so they do not pollute request latency samples.
 */
public final class LoadRunner {

    private static final Logger log = LoggerFactory.getLogger(LoadRunner.class);

    private static final String ENDPOINT_PRODUCTS = "GET /pay/products";
    private static final String ENDPOINT_MEMBERSHIP = "GET /internal/pay/membership";
    private static final String ENDPOINT_CREATE_ORDER = "POST /test/pay/orders";
    private static final String ENDPOINT_MOCK_PAY = "POST /test/pay/mock-pay";
    private static final String ENDPOINT_USER_CREATE = "POST /pay/orders";
    private static final String ENDPOINT_USER_CONFIRM = "POST /pay/mock/confirm";
    private static final String ENDPOINT_ORDER_LIST = "GET /pay/orders";
    private static final String ENDPOINT_ORDER_READ = "GET /pay/orders/{orderNo}";
    private static final String ENDPOINT_CACHE_MISS = "GET /pay/orders/{random}";
    private static final String ENDPOINT_HOT_KEY = "GET /pay/orders/hot";

    private static final AtomicLong HOT_UID_GENERATOR =
            new AtomicLong(System.currentTimeMillis() * 1000L);

    private final PayTestHttpClient http;
    private final PerfOptions options;
    private final AtomicLong writeUidGenerator = new AtomicLong(System.currentTimeMillis() * 1000L);
    private String hotOrderNo;
    private long hotUid;

    public LoadRunner(PayTestHttpClient http, PerfOptions options) {
        this.http = http;
        this.options = options;
    }

    /** Warmup phase; samples are discarded but errors are still reported. */
    public LoadPhaseResult warmup() {
        return runPhase("warmup", options.warmupThreads(), options.warmupSeconds());
    }

    /** Single measurement phase using the configured thread count. */
    public LoadPhaseResult measure() {
        return runPhase("measure", options.threads(), options.durationSeconds());
    }

    /** Measurement phase with an explicit thread count (used by ramp mode). */
    public LoadPhaseResult measure(int threads, int seconds) {
        return runPhase("measure", threads, seconds);
    }

    // ==================== phase execution ====================

    private LoadPhaseResult runPhase(String phase, int threads, int seconds) {
        if (threads <= 0 || seconds <= 0) {
            log.info("[perf] phase={} skipped threads={} seconds={}", phase, threads, seconds);
            return LoadPhaseResult.empty(phase, options.scenario(), Math.max(0, threads));
        }

        if (options.scenario() == PerfScenario.HOT_KEY
                || options.scenario() == PerfScenario.USER_READ) {
            prepareHotOrder();
        }

        Counters counters = new Counters();
        ErrorRecorder errorRecorder = new ErrorRecorder(options.maxLoggedErrors());
        long startedAt = System.nanoTime();
        long deadline = startedAt + TimeUnit.SECONDS.toNanos(seconds);

        log.info("[perf] phase={} started scenario={} threads={} durationSeconds={}",
                phase, options.scenario().configValue(), threads, seconds);

        ProgressTable progressTable = new ProgressTable();
        progressTable.logHeader(log, phase, threads);
        ScheduledExecutorService progress = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "pay-perf-progress");
            thread.setDaemon(true);
            return thread;
        });
        progress.scheduleAtFixedRate(
                () -> progressTable.logRow(log, phase, startedAt,
                        counters.requests.get(), counters.successfulRequests.get(),
                        counters.transactions.get(), counters.errors.get(),
                        counters.timeouts.get(), counters.retries.get(),
                        counters.maxActive.get()),
                options.logIntervalSeconds(), options.logIntervalSeconds(), TimeUnit.SECONDS);

        ExecutorService pool = Executors.newFixedThreadPool(threads, runnable -> {
            Thread thread = new Thread(runnable, "pay-perf-worker");
            thread.setDaemon(true);
            return thread;
        });
        CountDownLatch startLatch = new CountDownLatch(1);
        List<Future<WorkerResult>> futures = new ArrayList<>(threads);
        try {
            for (int i = 0; i < threads; i++) {
                futures.add(pool.submit(() -> {
                    startLatch.await();
                    return workerLoop(deadline, counters, errorRecorder);
                }));
            }
            startLatch.countDown();

            Map<String, LatencyDigest> merged = new LinkedHashMap<>();
            for (Future<WorkerResult> future : futures) {
                WorkerResult worker = future.get(seconds + 120L, TimeUnit.SECONDS);
                worker.endpoints().forEach((endpoint, digest) ->
                        merged.computeIfAbsent(endpoint, key -> new LatencyDigest()).addAll(digest));
            }

            double elapsedSeconds = Math.max(0.001,
                    TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startedAt));
            LoadPhaseResult result = new LoadPhaseResult(
                    phase, options.scenario(), threads, elapsedSeconds,
                    counters.requests.get(), counters.successfulRequests.get(),
                    counters.transactions.get(), counters.retries.get(),
                    counters.errors.get(), counters.serverErrors.get(), counters.clientErrors.get(),
                    counters.timeouts.get(), counters.otherErrors.get(), counters.bytes.get(),
                    counters.maxActive.get(),
                    merged, errorRecorder.breakdownSnapshot(), errorRecorder.sampleSnapshot());
            log.info("[perf] phase={} finished requests={} successfulRequests={} transactions={} "
                            + "retries={} errors={} errorRate={} qps={} ops={} rps={} tps={} "
                            + "maxConcurrency={} elapsedSeconds={}",
                    phase, result.requests(), result.successfulRequests(), result.transactions(),
                    result.retries(), result.errors(),
                    format("%.4f", result.errorRate()), format("%.1f", result.qps()),
                    format("%.1f", result.ops()), format("%.1f", result.rps()),
                    format("%.1f", result.tps()), result.maxConcurrency(),
                    format("%.1f", result.elapsedSeconds()));
            return result;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("load phase interrupted: " + phase, e);
        } catch (Exception e) {
            throw new IllegalStateException("load phase failed: " + phase, e);
        } finally {
            progress.shutdownNow();
            progressTable.logFooter(log);
            startLatch.countDown();
            pool.shutdownNow();
        }
    }

    /** Worker loop: execute the scenario until the phase deadline. */
    private WorkerResult workerLoop(long deadline, Counters counters, ErrorRecorder errorRecorder) {
        Map<String, LatencyDigest> digests = new LinkedHashMap<>();
        int iteration = 0;
        while (System.nanoTime() < deadline) {
            boolean transactionOk;
            switch (options.scenario()) {
                case WRITE -> transactionOk = writeOnce(digests, counters, errorRecorder);
                case MIXED -> transactionOk = iteration % 3 == 0
                        ? writeOnce(digests, counters, errorRecorder)
                        : readOnce(digests, counters, errorRecorder);
                case USER_WRITE -> transactionOk = userWriteOnce(digests, counters, errorRecorder);
                case USER_READ -> transactionOk = userReadOnce(digests, counters, errorRecorder);
                case CACHE_MISS -> transactionOk = cacheMissOnce(digests, counters, errorRecorder);
                case HOT_KEY -> transactionOk = hotKeyOnce(digests, counters, errorRecorder);
                case READ -> transactionOk = readOnce(digests, counters, errorRecorder);
                default -> transactionOk = false;
            }
            if (transactionOk) {
                counters.transactions.incrementAndGet();
            }
            iteration++;
        }
        return new WorkerResult(digests);
    }

    /** Read scenario: product list + internal membership lookup. */
    private boolean readOnce(Map<String, LatencyDigest> digests,
                             Counters counters, ErrorRecorder errorRecorder) {
        boolean productsOk = send(ENDPOINT_PRODUCTS, 0,
                () -> http.getWithUid("/pay/products", 10086L),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder) != null;
        boolean membershipOk = send(ENDPOINT_MEMBERSHIP, 0,
                () -> http.getInternal("/internal/pay/membership/10086"),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder) != null;
        return productsOk && membershipOk;
    }

    /** Real user path: POST /pay/orders with X-Uid + POST /pay/mock/confirm. */
    private boolean userWriteOnce(Map<String, LatencyDigest> digests,
                                  Counters counters, ErrorRecorder errorRecorder) {
        long uid = writeUidGenerator.incrementAndGet();
        String createBody = "{\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}";
        PayTestHttpClient.HttpResult created = send(ENDPOINT_USER_CREATE,
                createBody.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                () -> http.postJson("/pay/orders", createBody,
                        Map.of("X-Uid", String.valueOf(uid))),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder);
        if (created == null) {
            return false;
        }
        String orderNo = PayTestHttpClient.extractOrderNo(created.bodyOrEmpty());
        if (orderNo == null || orderNo.isBlank()) {
            counters.errors.incrementAndGet();
            counters.otherErrors.incrementAndGet();
            errorRecorder.record(ENDPOINT_USER_CREATE, "other", created.status(),
                    "response missing orderNo", 0, null);
            return false;
        }
        String confirmBody = "{\"orderNo\":\"" + orderNo + "\"}";
        PayTestHttpClient.HttpResult paid = send(ENDPOINT_USER_CONFIRM,
                confirmBody.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                () -> http.postJson("/pay/mock/confirm", confirmBody,
                        Map.of("X-Uid", String.valueOf(uid))),
                result -> result.success()
                        && result.bodyOrEmpty().contains("DELIVERED"),
                digests, counters, errorRecorder);
        return paid != null;
    }

    /** Real user order read path: GET /pay/orders?limit=5 + GET /pay/orders/{orderNo}. */
    private boolean userReadOnce(Map<String, LatencyDigest> digests,
                                 Counters counters, ErrorRecorder errorRecorder) {
        boolean listOk = send(ENDPOINT_ORDER_LIST,
                0,
                () -> http.getWithUid("/pay/orders?limit=5", hotUid),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder) != null;
        boolean detailOk = send(ENDPOINT_ORDER_READ,
                0,
                () -> http.getWithUid("/pay/orders/" + hotOrderNo, hotUid),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder) != null;
        return listOk && detailOk;
    }

    /** Cache-penetration probe: random non-existent order numbers; HTTP 404 is the expected result. */
    private boolean cacheMissOnce(Map<String, LatencyDigest> digests,
                                  Counters counters, ErrorRecorder errorRecorder) {
        String orderNo = "PO" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        PayTestHttpClient.HttpResult result = send(ENDPOINT_CACHE_MISS,
                0,
                () -> http.getWithUid("/pay/orders/" + orderNo, 10086L),
                r -> r.status() == 404, digests, counters, errorRecorder);
        return result != null;
    }

    /** Cache-breakdown probe: every client reads the same existing order. */
    private boolean hotKeyOnce(Map<String, LatencyDigest> digests,
                               Counters counters, ErrorRecorder errorRecorder) {
        PayTestHttpClient.HttpResult result = send(ENDPOINT_HOT_KEY,
                0,
                () -> http.getWithUid("/pay/orders/" + hotOrderNo, hotUid),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder);
        return result != null;
    }

    /** Create the single hot order used by the HOT_KEY scenario (test-entry so it is deterministic). */
    private void prepareHotOrder() {
        hotUid = HOT_UID_GENERATOR.incrementAndGet();
        String body = "{\"uid\":" + hotUid
                + ",\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}";
        try {
            PayTestHttpClient.HttpResult created =
                    http.testEntryPostJson("/test/pay/orders", body);
            if (created == null || !created.success()) {
                throw new IllegalStateException("hot-key setup failed status="
                        + (created == null ? "null" : created.status()));
            }
            hotOrderNo = PayTestHttpClient.extractOrderNo(created.bodyOrEmpty());
            if (hotOrderNo == null || hotOrderNo.isBlank()) {
                throw new IllegalStateException("hot-key setup response missing orderNo");
            }
            log.info("[perf] hot-key prepared orderNo={} uid={}", hotOrderNo, hotUid);
        } catch (Exception e) {
            throw new IllegalStateException("failed to prepare hot-key order", e);
        }
    }

    /** Write scenario: test-entry order creation + MOCK payment. */
    private boolean writeOnce(Map<String, LatencyDigest> digests,
                              Counters counters, ErrorRecorder errorRecorder) {
        long uid = writeUidGenerator.incrementAndGet();
        String createBody = buildCreateOrderJson(uid);
        PayTestHttpClient.HttpResult created = send(ENDPOINT_CREATE_ORDER,
                createBody.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                () -> http.testEntryPostJson("/test/pay/orders", createBody),
                PayTestHttpClient.HttpResult::success, digests, counters, errorRecorder);
        if (created == null || !created.success()) {
            return false;
        }
        String orderNo = PayTestHttpClient.extractOrderNo(created.bodyOrEmpty());
        if (orderNo == null || orderNo.isBlank()) {
            counters.errors.incrementAndGet();
            counters.otherErrors.incrementAndGet();
            errorRecorder.record(ENDPOINT_CREATE_ORDER, "other", created.status(),
                    "response missing orderNo", 0, null);
            return false;
        }
        String payBody = "{\"uid\":" + uid + ",\"orderNo\":\"" + orderNo + "\"}";
        PayTestHttpClient.HttpResult paid = send(ENDPOINT_MOCK_PAY,
                payBody.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                () -> http.testEntryPostJson("/test/pay/mock-pay", payBody),
                result -> result.success() && result.bodyOrEmpty().contains("DELIVERED"),
                digests, counters, errorRecorder);
        return paid != null && paid.success();
    }

    /**
     * Send one request with optional retries, classify the outcome, record latency/bytes.
     *
     * <p>Retries only apply to connection/timeout exceptions; HTTP 4xx/5xx are
     * returned as-is so error rates stay honest.
     */
    private PayTestHttpClient.HttpResult send(
            String endpoint,
            long requestBytes,
            HttpCall call,
            Predicate<PayTestHttpClient.HttpResult> validator,
            Map<String, LatencyDigest> digests,
            Counters counters,
            ErrorRecorder errorRecorder) {
        int attempt = 0;
        while (true) {
            counters.requests.incrementAndGet();
            int active = counters.active.incrementAndGet();
            counters.maxActive.accumulateAndGet(active, Math::max);
            long startedAt = System.nanoTime();
            try {
                PayTestHttpClient.HttpResult result = call.execute();
                long elapsed = System.nanoTime() - startedAt;
                counters.bytes.addAndGet(requestBytes + result.bodyOrEmpty()
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                if (!validator.test(result)) {
                    classifyHttpFailure(counters, errorRecorder, endpoint, result, elapsed);
                    return null;
                }
                counters.successfulRequests.incrementAndGet();
                digests.computeIfAbsent(endpoint, key -> new LatencyDigest()).add(elapsed);
                return result;
            } catch (Exception e) {
                long elapsed = System.nanoTime() - startedAt;
                if (attempt < options.maxRetries() && isRetryable(e)) {
                    counters.retries.incrementAndGet();
                    attempt++;
                    continue;
                }
                classifyException(counters, errorRecorder, endpoint, e, elapsed);
                return null;
            } finally {
                counters.active.decrementAndGet();
            }
        }
    }

    private void classifyHttpFailure(Counters counters, ErrorRecorder recorder, String endpoint,
                                     PayTestHttpClient.HttpResult result, long elapsed) {
        counters.errors.incrementAndGet();
        String category;
        if (result.status() >= 500) {
            counters.serverErrors.incrementAndGet();
            category = "5xx";
        } else if (result.status() >= 400) {
            counters.clientErrors.incrementAndGet();
            category = "4xx";
        } else {
            counters.otherErrors.incrementAndGet();
            category = "other";
        }
        recorder.record(endpoint, category, result.status(), result.bodyOrEmpty(), elapsed, null);
    }

    private void classifyException(Counters counters, ErrorRecorder recorder, String endpoint,
                                   Exception exception, long elapsed) {
        counters.errors.incrementAndGet();
        String category;
        if (isTimeout(exception)) {
            counters.timeouts.incrementAndGet();
            category = "timeout";
        } else {
            counters.otherErrors.incrementAndGet();
            category = "exception";
        }
        recorder.record(endpoint, category, -1, null, elapsed, exception);
    }

    private static boolean isRetryable(Exception exception) {
        return isTimeout(exception) || exception instanceof java.io.IOException;
    }

    private static boolean isTimeout(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof HttpTimeoutException
                    || current instanceof java.net.SocketTimeoutException) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    /** Build the create-order request body; padding exercises body/buffer limits. */
    private String buildCreateOrderJson(long uid) {
        StringBuilder json = new StringBuilder("{\"uid\":").append(uid)
                .append(",\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"");
        int padding = Math.min(options.payloadPaddingBytes(), 4 * 1024 * 1024);
        if (padding > 0) {
            json.append(",\"padding\":\"").append("x".repeat(padding)).append("\"");
        }
        json.append("}");
        return json.toString();
    }

    private static String format(String pattern, double value) {
        return String.format(Locale.ROOT, pattern, value);
    }

    // ==================== internal structures ====================

    @FunctionalInterface
    private interface HttpCall {
        PayTestHttpClient.HttpResult execute() throws Exception;
    }

    private record WorkerResult(Map<String, LatencyDigest> endpoints) {
    }

    private static final class Counters {
        private final AtomicLong requests = new AtomicLong();
        private final AtomicLong successfulRequests = new AtomicLong();
        private final AtomicLong transactions = new AtomicLong();
        private final AtomicLong retries = new AtomicLong();
        private final AtomicLong errors = new AtomicLong();
        private final AtomicLong serverErrors = new AtomicLong();
        private final AtomicLong clientErrors = new AtomicLong();
        private final AtomicLong timeouts = new AtomicLong();
        private final AtomicLong otherErrors = new AtomicLong();
        private final AtomicLong bytes = new AtomicLong();
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger maxActive = new AtomicInteger();
    }

    /** Thread-safe error aggregation with a bounded sample list. */
    private static final class ErrorRecorder {

        private final int maxSamples;
        private final ConcurrentHashMap<String, AtomicLong> breakdown = new ConcurrentHashMap<>();
        private final List<LoadPhaseResult.ErrorSample> samples =
                java.util.Collections.synchronizedList(new ArrayList<>());

        private ErrorRecorder(int maxSamples) {
            this.maxSamples = maxSamples;
        }

        private void record(String endpoint, String category, int status, String body,
                            long elapsedNanos, Exception exception) {
            String key = endpoint + "|" + category + "|"
                    + (exception == null ? "status=" + status
                    : "exception=" + exception.getClass().getSimpleName());
            breakdown.computeIfAbsent(key, ignored -> new AtomicLong()).incrementAndGet();
            if (samples.size() < maxSamples) {
                samples.add(new LoadPhaseResult.ErrorSample(
                        endpoint,
                        category,
                        status,
                        snippet(body),
                        exception == null ? null
                                : exception.getClass().getSimpleName() + ": " + exception.getMessage(),
                        elapsedNanos / 1_000_000.0,
                        System.currentTimeMillis()));
            }
        }

        private Map<String, Long> breakdownSnapshot() {
            Map<String, Long> snapshot = new LinkedHashMap<>();
            breakdown.entrySet().stream()
                    .sorted((left, right) -> Long.compare(
                            right.getValue().get(), left.getValue().get()))
                    .forEach(entry -> snapshot.put(entry.getKey(), entry.getValue().get()));
            return snapshot;
        }

        private List<LoadPhaseResult.ErrorSample> sampleSnapshot() {
            synchronized (samples) {
                return new ArrayList<>(samples);
            }
        }

        private static String snippet(String body) {
            if (body == null) {
                return null;
            }
            String oneLine = body.replaceAll("\\s+", " ").trim();
            return oneLine.length() <= 300 ? oneLine : oneLine.substring(0, 300) + "...(truncated)";
        }
    }
}