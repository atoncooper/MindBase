package com.mindbase.pay.e2e.performance;

/**
 * Load-test scenario.
 *
 * <ul>
 *   <li>READ: public products + internal membership read path;</li>
 *   <li>WRITE: test-entry order creation + MOCK payment;</li>
 *   <li>MIXED: 2 reads + 1 write per iteration;</li>
 *   <li>USER_WRITE: real user path (X-Uid) create order + mock confirm;</li>
 *   <li>USER_READ: real user path (X-Uid) order list + order detail;</li>
 *   <li>CACHE_MISS: random non-existent order numbers (404 expected; cache penetration);</li>
 *   <li>HOT_KEY: the same existing order number from many clients (cache breakdown/hot key).</li>
 * </ul>
 */
public enum PerfScenario {

    READ("read"),
    WRITE("write"),
    MIXED("mixed"),
    USER_WRITE("user-write"),
    USER_READ("user-read"),
    CACHE_MISS("cache-miss"),
    HOT_KEY("hot-key");

    private final String configValue;

    PerfScenario(String configValue) {
        this.configValue = configValue;
    }

    public String configValue() {
        return configValue;
    }

    /** Parse the configured scenario; fail fast on typos instead of silently running another scenario. */
    public static PerfScenario parse(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("perf.scenario must not be empty");
        }
        for (PerfScenario scenario : values()) {
            if (scenario.configValue.equalsIgnoreCase(raw.trim())) {
                return scenario;
            }
        }
        throw new IllegalArgumentException(
                "perf.scenario must be read/write/mixed/user-write/user-read/cache-miss/hot-key, actual=" + raw);
    }
}