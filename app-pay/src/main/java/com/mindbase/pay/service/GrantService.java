package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.LogSanitizer;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayGrantIdempotencyMapper;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.model.PayGrantIdempotency;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDateTime;

/**
 * 运营补偿开通（ADMIN_GRANT）编排（P0/P1 加固）：
 *
 * <ol>
 *   <li>幂等：request_id 先在 pay_grant_idempotency 占位（主键），与会员扩展同事务。
 *       并发/网关重试/人工重放命中主键冲突 = 幂等命中，直接返回当前会员态，绝不重复加天数；</li>
 *   <li>额度：GrantQuotaService.reserve 在同一事务内锁行、校验、原子累加，超限 429 且不留半成品；</li>
 *   <li>扩展：membershipService.extend(..., requestId) 把 requestId 落到事件表（唯一索引兜底）。</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GrantService {

    private final PayGrantIdempotencyMapper idempotencyMapper;
    private final PayMembershipEventMapper eventMapper;
    private final GrantQuotaService quotaService;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;
    private final Clock clock;

    @Transactional
    public PayMembership grant(long uid, int durationDays, String reason, String tier, String requestId) {
        String rid = normalize(requestId);
        if (rid != null) {
            PayMembershipEvent processed = findProcessedEvent(rid);
            if (processed != null) {
                return idempotentResult(uid, rid, "event_exists");
            }
            PayGrantIdempotency marker = new PayGrantIdempotency();
            marker.setRequestId(rid);
            marker.setUid(uid);
            marker.setCreatedAt(LocalDateTime.now(clock));
            try {
                idempotencyMapper.insert(marker);
            } catch (DuplicateKeyException e) {
                return idempotentResult(uid, rid, "request_id_duplicate");
            }
        }
        // 与会员扩展同事务：扩展失败会连额度占用/幂等占位一起回滚，可安全重试。
        // reason 原样入库（DB 字段 200 长度已由 DTO 校验）；仅日志/审计侧做控制字符清洗。
        quotaService.reserve(durationDays);
        return membershipService.extend(uid, durationDays, null,
                PayMembershipEvent.EventType.ADMIN_GRANT, reason, tier, rid);
    }

    /** 幂等命中：返回当前会员态（不重复加天数），并留审计。 */
    private PayMembership idempotentResult(long uid, String requestId, String hitType) {
        audit.audit("GRANT_IDEMPOTENT_HIT", "uid", uid, "request_id", requestId, "hit", hitType);
        log.info("[PAY] grant_idempotent_hit uid={} request_id={} hit={}", uid, requestId, hitType);
        return membershipService.findByUid(uid).orElseThrow(() -> ApiException.conflict(
                "GRANT_IDEMPOTENT_STATE_MISSING", "Grant already processed but membership row is missing"));
    }

    private PayMembershipEvent findProcessedEvent(String requestId) {
        return eventMapper.selectOne(new LambdaQueryWrapper<PayMembershipEvent>()
                .eq(PayMembershipEvent::getRequestId, requestId)
                .last("LIMIT 1"));
    }

    private static String normalize(String requestId) {
        if (requestId == null || requestId.isBlank()) {
            return null;
        }
        return requestId.trim();
    }
}
