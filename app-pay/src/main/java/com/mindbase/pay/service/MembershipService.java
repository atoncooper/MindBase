package com.mindbase.pay.service;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.Optional;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.mapper.PayMembershipMapper;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * 会员开通/顺延。到期判断是懒过期（expire_at > now 即有效）；
 * 顺延前对会员行 FOR UPDATE 加锁，串行化同一用户并发交付。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MembershipService {

    private final PayMembershipMapper membershipMapper;
    private final PayMembershipEventMapper eventMapper;
    private final PayAuditLogger audit;
    private final Clock clock;

    /**
     * 为用户延长 days 天会员。
     *
     * @param explicitType ADMIN_GRANT 等调用方指定类型；null 时按是否首开自动判定 ACTIVATE/RENEW
     */
    @Transactional
    public PayMembership extend(
        long uid, 
        int days, 
        String orderNo,
        PayMembershipEvent.EventType explicitType, 
        String reason) {
        return extend(uid, days, orderNo, explicitType, reason, null);
    }

    /** Tier-aware overload: tier null/blank keeps the existing row's tier (or defaults VIP on create). */
    public PayMembership extend(
        long uid,
        int days,
        String orderNo,
        PayMembershipEvent.EventType explicitType,
        String reason,
        String tier) {
        LocalDateTime now = LocalDateTime.now(clock);
        PayMembership membership = membershipMapper.selectByUidForUpdate(uid);

        LocalDateTime expireBefore;
        PayMembershipEvent.EventType type;
        if (membership == null) {
            membership = new PayMembership();
            membership.setUid(uid);
            expireBefore = now;
            type = explicitType != null ? explicitType : PayMembershipEvent.EventType.ACTIVATE;
        } else {
            expireBefore = membership.getExpireAt();
            boolean stillActive = expireBefore.isAfter(now);
            type = explicitType != null ? explicitType
                    : (stillActive ? PayMembershipEvent.EventType.RENEW
                                   : PayMembershipEvent.EventType.ACTIVATE);
        }

        // 未到期续费从当前到期时间顺延叠加；已过期从当前时间起算
        LocalDateTime base = expireBefore.isAfter(now) ? expireBefore : now;
        membership.setExpireAt(base.plusDays(days));
        membership.setLastOrderNo(orderNo);
        // tier: explicit value wins; a new row defaults to VIP
        if (tier != null && !tier.isBlank()) {
            membership.setTier(tier);
        }
        membership.setUpdatedAt(now);
        if (membership.getId() == null) {
            membershipMapper.insert(membership);
        } else {
            membershipMapper.updateById(membership);
        }

        PayMembershipEvent event = new PayMembershipEvent();
        event.setUid(uid);
        event.setType(type);
        event.setOrderNo(orderNo);
        event.setDays(days);
        event.setExpireBefore(expireBefore);
        event.setExpireAfter(membership.getExpireAt());
        event.setReason(reason);
        eventMapper.insert(event);

        log.info("[PAY] membership_extend type={} days={} order_no={} expire_after={}",
                type, days, orderNo, membership.getExpireAt());
        audit.audit("MEMBERSHIP_EXTENDED", "uid", uid, "type", type.name(), "days", days,
                "order_no", orderNo, "expire_after", membership.getExpireAt().toString());
        return membership;
    }

    @Transactional(readOnly = true)
    public Optional<PayMembership> findByUid(long uid) {
        return Optional.ofNullable(membershipMapper.selectOne(
                new LambdaQueryWrapper<PayMembership>().eq(PayMembership::getUid, uid)));
    }

    public boolean isActive(PayMembership membership) {
        return membership.getExpireAt().isAfter(LocalDateTime.now(clock));
    }
}
