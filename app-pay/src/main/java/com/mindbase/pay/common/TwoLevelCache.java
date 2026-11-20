package com.mindbase.pay.common;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Small two-level cache for read-only catalog data.
 *
 * <pre>
 * L1: bounded in-process map with per-entry TTL (microsecond access, per instance)
 * L2: optional Redis (shared across instances, survives app restart)
 * DB: source of truth on miss
 * </pre>
 *
 * <p>Redis is optional: with `pay.cache.redis-enabled=false` (default) the
 * cache is L1-only and no Redis connection is attempted. Any Redis failure is
 * fail-open (log once, continue with L1 + DB); payment writes never depend on
 * cache availability.
 *
 * <p>Only immutable/read-only data (product catalog) is cached here. Order and
 * membership rows are mutable financial state and are intentionally not cached
 * without explicit invalidation.
 */
@Component
public class TwoLevelCache {

    private static final Logger log = LoggerFactory.getLogger(TwoLevelCache.class);

    private final ObjectMapper mapper;
    private final ObjectProvider<StringRedisTemplate> redisProvider;
    private final ConcurrentHashMap<String, LocalEntry> local = new ConcurrentHashMap<>();
    private final AtomicBoolean redisFailureLogged = new AtomicBoolean();

    @Value("${pay.cache.redis-enabled:false}")
    private boolean redisEnabled;

    @Value("${pay.cache.l1-ttl-seconds:5}")
    private long l1TtlSeconds = 5;

    @Value("${pay.cache.max-local-entries:1000}")
    private int maxLocalEntries = 1000;

    public TwoLevelCache(ObjectMapper mapper, ObjectProvider<StringRedisTemplate> redisProvider) {
        this.mapper = mapper;
        this.redisProvider = redisProvider;
    }

    /** Read L1, then L2; returns null on miss or any cache failure. */
    public <T> T get(String key, TypeReference<T> type) {
        long now = System.nanoTime();
        LocalEntry entry = local.get(key);
        if (entry != null && entry.expiresAtNanos() > now) {
            @SuppressWarnings("unchecked")
            T value = (T) entry.value();
            return value;
        }
        if (entry != null) {
            local.remove(key);
        }

        StringRedisTemplate redis = redis();
        if (redis == null) {
            return null;
        }
        try {
            String json = redis.opsForValue().get(key);
            if (json == null || json.isBlank()) {
                return null;
            }
            T value = mapper.readValue(json, type);
            local.put(key, new LocalEntry(value, now + Duration.ofSeconds(l1TtlSeconds).toNanos()));
            trimLocalIfNeeded();
            return value;
        } catch (Exception e) {
            warnRedisFailure(e);
            return null;
        }
    }

    /** Write L1 always; write L2 when Redis is enabled and reachable. */
    public void put(String key, Object value, Duration redisTtl) {
        local.put(key, new LocalEntry(value,
                System.nanoTime() + Duration.ofSeconds(l1TtlSeconds).toNanos()));
        trimLocalIfNeeded();

        StringRedisTemplate redis = redis();
        if (redis == null) {
            return;
        }
        try {
            redis.opsForValue().set(key, mapper.writeValueAsString(value), redisTtl);
        } catch (Exception e) {
            warnRedisFailure(e);
        }
    }

    /** Remove from both levels (used when the underlying catalog is refreshed). */
    public void evict(String key) {
        local.remove(key);
        StringRedisTemplate redis = redis();
        if (redis == null) {
            return;
        }
        try {
            redis.delete(key);
        } catch (Exception e) {
            warnRedisFailure(e);
        }
    }

    private StringRedisTemplate redis() {
        if (!redisEnabled) {
            return null;
        }
        StringRedisTemplate template = redisProvider.getIfAvailable();
        if (template == null) {
            warnRedisFailure(new IllegalStateException("StringRedisTemplate bean unavailable"));
            return null;
        }
        return template;
    }

    private void trimLocalIfNeeded() {
        if (local.size() > maxLocalEntries) {
            local.clear();
        }
    }

    private void warnRedisFailure(Exception e) {
        if (redisFailureLogged.compareAndSet(false, true)) {
            log.warn("[PAY] cache_redis_unavailable -- falling back to L1/DB: {}", e.toString());
        }
    }

    private record LocalEntry(Object value, long expiresAtNanos) {
    }
}
