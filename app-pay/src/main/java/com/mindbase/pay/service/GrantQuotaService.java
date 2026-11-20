package com.mindbase.pay.service;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayGrantQuotaMapper;
import com.mindbase.pay.model.PayGrantQuota;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * ADMIN_GRANT 日额度熔断（P0/P2 加固）：按“本地自然日”统计次数与总天数。
 *
 * <p>旧实现是“事务外 SELECT COUNT/SUM，再 INSERT 事件”的 check-then-act：并发 K 个请求
 * 都读到旧值全部通过，日上限 50 次/1000 天实际可被放大 N 倍。现在：
 * ensureDay（幂等建行）→ lockDay（SELECT ... FOR UPDATE，串行化同一天的所有补偿开通）
 * → 校验 → consume（原子累加）；与会员扩展同一事务，扩展失败会一并回滚额度占用。
 *
 * <p>统计索引不再是热点；计数行只有一行，锁竞争仅发生在 rare 的运营补偿路径。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GrantQuotaService {

    private final PayGrantQuotaMapper quotaMapper;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final PayProperties payProperties;
    private final Clock clock;

    /**
     * 在校验通过后原子占用一次额度；超限抛 429。必须在事务内调用（与 grant 的会员扩展同事务），
     * 否则锁会提前释放、且失败时额度无法回滚。
     */
    @Transactional
    public void reserve(int requestedDays) {
        PayProperties.Grant grant = payProperties.grant();
        if (grant == null || !grant.enabled()) {
            return;
        }
        LocalDate day = LocalDate.now(clock);
        LocalDateTime now = LocalDateTime.now(clock);
        quotaMapper.ensureDay(day, now);
        PayGrantQuota quota = quotaMapper.lockDay(day);
        if (quota == null) {
            throw new IllegalStateException("[PAY] grant quota row missing after ensureDay day=" + day);
        }
        int count = quota.getCnt();
        int days = quota.getDays();
        if (grant.dailyMaxCount() > 0 && count >= grant.dailyMaxCount()) {
            metrics.grantQuotaExceeded();
            audit.audit("GRANT_DAILY_COUNT_EXCEEDED", "count", count,
                    "max", grant.dailyMaxCount(), "requested_days", requestedDays);
            log.warn("[PAY] grant_daily_count_exceeded count={} max={}", count, grant.dailyMaxCount());
            throw ApiException.tooManyRequests("GRANT_DAILY_COUNT_EXCEEDED",
                    "Daily admin-grant count limit reached (" + count + "/" + grant.dailyMaxCount() + ")");
        }
        if (grant.dailyMaxDays() > 0 && days + Math.max(requestedDays, 0) > grant.dailyMaxDays()) {
            metrics.grantQuotaExceeded();
            audit.audit("GRANT_DAILY_DAYS_EXCEEDED", "days", days,
                    "max", grant.dailyMaxDays(), "requested_days", requestedDays);
            log.warn("[PAY] grant_daily_days_exceeded days={} max={} requested={}",
                    days, grant.dailyMaxDays(), requestedDays);
            throw ApiException.tooManyRequests("GRANT_DAILY_DAYS_EXCEEDED",
                    "Daily admin-grant days limit reached (" + days + "/" + grant.dailyMaxDays() + ")");
        }
        quotaMapper.consume(day, Math.max(requestedDays, 0), now);
    }
}
