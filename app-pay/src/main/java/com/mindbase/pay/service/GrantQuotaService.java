package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.model.PayMembershipEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * ADMIN_GRANT 日额度熔断：按"本地自然日"统计 ADMIN_GRANT 事件的次数与总天数，
 * 任一上限触顶即拒绝（429）并审计 —— 即使内部密钥泄漏，也无法无限批量补偿开通会员。
 * 0 = 不限该维度。统计索引见 V4 迁移（idx_pay_pme_type_created）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GrantQuotaService {

    private final PayMembershipEventMapper eventMapper;
    private final PayAuditLogger audit;
    private final PayProperties payProperties;
    private final Clock clock;

    /** @param requestedDays 本次拟补偿的天数（计入当日总额度） */
    public void checkDailyQuota(int requestedDays) {
        PayProperties.Grant grant = payProperties.grant();
        if (grant == null || !grant.enabled()) {
            return;
        }
        LocalDateTime dayStart = LocalDate.now(clock).atStartOfDay();
        List<PayMembershipEvent> todays = eventMapper.selectList(
                new LambdaQueryWrapper<PayMembershipEvent>()
                        .eq(PayMembershipEvent::getType, PayMembershipEvent.EventType.ADMIN_GRANT)
                        .ge(PayMembershipEvent::getCreatedAt, dayStart));
        int count = todays.size();
        int days = todays.stream().mapToInt(PayMembershipEvent::getDays).sum();
        if (grant.dailyMaxCount() > 0 && count >= grant.dailyMaxCount()) {
            audit.audit("GRANT_DAILY_COUNT_EXCEEDED", "count", count,
                    "max", grant.dailyMaxCount(), "requested_days", requestedDays);
            log.warn("[PAY] grant_daily_count_exceeded count={} max={}", count, grant.dailyMaxCount());
            throw ApiException.tooManyRequests("GRANT_DAILY_COUNT_EXCEEDED",
                    "Daily admin-grant count limit reached (" + count + "/" + grant.dailyMaxCount() + ")");
        }
        if (grant.dailyMaxDays() > 0 && days + Math.max(requestedDays, 0) > grant.dailyMaxDays()) {
            audit.audit("GRANT_DAILY_DAYS_EXCEEDED", "days", days,
                    "max", grant.dailyMaxDays(), "requested_days", requestedDays);
            log.warn("[PAY] grant_daily_days_exceeded days={} max={} requested={}",
                    days, grant.dailyMaxDays(), requestedDays);
            throw ApiException.tooManyRequests("GRANT_DAILY_DAYS_EXCEEDED",
                    "Daily admin-grant days limit reached (" + days + "/" + grant.dailyMaxDays() + ")");
        }
    }
}
