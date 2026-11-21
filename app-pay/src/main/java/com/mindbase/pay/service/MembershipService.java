package com.mindbase.pay.service;

import java.time.Clock;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.Optional;

import com.fasterxml.jackson.core.type.TypeReference;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.TwoLevelCache;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.mapper.PayMembershipMapper;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Membership activation/renewal/revocation. Expiry is evaluated lazily (valid while expire_at > now);
 * before extending, the membership row is locked with FOR UPDATE to serialize concurrent delivery for the same user.
 *
 * <p><b>Transaction boundary</b>: both extend overloads must carry @Transactional -- the 5-arg version delegates
 * to the 6-arg version, and if the annotation only sat on the 5-arg one, an admin grant (the controller calls the
 * 6-arg version directly) would run under autocommit, releasing the FOR UPDATE immediately and making the event
 * insert non-atomic. See MembershipServiceTxTest.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MembershipService {

    private static final String MEMBERSHIP_CACHE_PREFIX = "pay:cache:v1:membership:";
    private static final Duration MEMBERSHIP_CACHE_TTL = Duration.ofSeconds(1);
    private static final TypeReference<PayMembership> MEMBERSHIP_CACHE_TYPE =
            new TypeReference<>() {
            };

    private final PayMembershipMapper membershipMapper;
    private final PayMembershipEventMapper eventMapper;
    private final PayAuditLogger audit;
    private final TwoLevelCache cache;
    private final Clock clock;

    /**
     * Extends the user's membership by the given number of days.
     *
     * @param explicitType type specified by the caller such as ADMIN_GRANT; when null, ACTIVATE/RENEW is chosen
     *                     automatically based on whether this is the first activation
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

    /**
     * Tier-aware overload: a null/blank tier keeps the existing row's tier (new rows default to VIP).
     * &#064;Transactional  must be on this overload -- it is the direct entry point of GrantService.
     */
    @Transactional
    public PayMembership extend(
        long uid,
        int days,
        String orderNo,
        PayMembershipEvent.EventType explicitType,
        String reason,
        String tier) {
        return extend(uid, days, orderNo, explicitType, reason, tier, null);
    }

    /**
     * Idempotency-aware overload (ADMIN_GRANT): requestId is written to pay_membership_event.request_id
     * (unique key). A duplicated grant retried by the gateway/proxy carries the same requestId and is
     * deduplicated by GrantService before reaching here; this method only persists the key so the
     * race backstop still works at the database layer.
     */
    @Transactional
    public PayMembership extend(
        long uid,
        int days,
        String orderNo,
        PayMembershipEvent.EventType explicitType,
        String reason,
        String tier,
        String requestId) {
        return doExtend(membershipMapper.selectByUidForUpdate(uid), uid, days, orderNo,
                explicitType, reason, tier, requestId);
    }

    /**
     * DeliveryService already holds the membership row lock (FOR UPDATE) before calling
     * delivery. Reusing that locked entity removes a second SELECT ... FOR UPDATE from
     * every delivered order on the payment hot path.
     */
    @Transactional
    public PayMembership extendLocked(
        PayMembership locked,
        long uid,
        int days,
        String orderNo,
        PayMembershipEvent.EventType explicitType,
        String reason,
        String tier) {
        return doExtend(locked, uid, days, orderNo, explicitType, reason, tier, null);
    }

    private PayMembership doExtend(
        PayMembership membership,
        long uid,
        int days,
        String orderNo,
        PayMembershipEvent.EventType explicitType,
        String reason,
        String tier,
        String requestId) {
        LocalDateTime now = LocalDateTime.now(clock);

        LocalDateTime expireBefore;
        PayMembershipEvent.EventType type;
        boolean stillActive;
        if (membership == null) {
            membership = new PayMembership();
            membership.setUid(uid);
            expireBefore = now;
            stillActive = false;
            type = explicitType != null ? explicitType : PayMembershipEvent.EventType.ACTIVATE;
        } else {
            expireBefore = membership.getExpireAt();
            stillActive = expireBefore.isAfter(now);
            type = explicitType != null ? explicitType
                    : (stillActive ? PayMembershipEvent.EventType.RENEW
                                   : PayMembershipEvent.EventType.ACTIVATE);
        }

        // A renewal before expiry stacks on top of the current expiry; an expired membership counts from now
        LocalDateTime base = expireBefore.isAfter(now) ? expireBefore : now;
        membership.setExpireAt(base.plusDays(days));
        membership.setLastOrderNo(orderNo);
        applyTier(membership, tier, stillActive, uid, orderNo);
        membership.setUpdatedAt(now);
        if (membership.getId() == null) {
            membershipMapper.insert(membership);
        } else {
            membershipMapper.updateById(membership);
        }

        insertEvent(membership, uid, type, orderNo, days, expireBefore, reason, requestId);
        // Drop the read cache before returning; a concurrent reader may re-populate it
        // from the DB after commit, which is safe (short TTL + write eviction).
        cache.evict(MEMBERSHIP_CACHE_PREFIX + uid);
        log.info("[PAY] membership_extend type={} days={} order_no={} tier={} expire_after={} request_id={}",
                type, days, orderNo, membership.getTier(), membership.getExpireAt(), requestId);
        audit.audit("MEMBERSHIP_EXTENDED", "uid", uid, "type", type.name(), "days", days,
                "order_no", orderNo, "tier", membership.getTier(),
                "expire_after", membership.getExpireAt().toString());
        return membership;
    }

    /**
     * Refund revocation: subtracts days from the expiry (never earlier than now, so consumed time never yields a
     * negative membership period) and records a REFUND_REVOKE event.
     * Idempotency is the caller's responsibility (the refund orchestration calls this once per order; a repeated
     * call would subtract again).
     */
    @Transactional
    public Optional<PayMembership> revoke(long uid, int days, String orderNo, String reason) {
        LocalDateTime now = LocalDateTime.now(clock);
        PayMembership membership = membershipMapper.selectByUidForUpdate(uid);
        if (membership == null) {
            log.warn("[PAY] membership_revoke_no_row uid={} order_no={}", uid, orderNo);
            return Optional.empty();
        }
        LocalDateTime expireBefore = membership.getExpireAt();
        LocalDateTime expireAfter = expireBefore.minusDays(days);
        if (expireAfter.isBefore(now)) {
            expireAfter = now; // never produce a negative membership period
        }
        membership.setExpireAt(expireAfter);
        membership.setUpdatedAt(now);
        membershipMapper.updateById(membership);

        insertEvent(membership, uid, PayMembershipEvent.EventType.REFUND_REVOKE,
                orderNo, -days, expireBefore, reason, null);
        cache.evict(MEMBERSHIP_CACHE_PREFIX + uid);
        log.info("[PAY] membership_revoked uid={} days={} order_no={} expire_after={}",
                uid, days, orderNo, expireAfter);
        audit.audit("MEMBERSHIP_REVOKED", "uid", uid, "days", days, "order_no", orderNo,
                "expire_after", expireAfter.toString());
        return Optional.of(membership);
    }

    /**
     * Tier write: adopt the requested tier when valid, but never downgrade while the membership is still active
     * (an SVIP user buying a VIP monthly card must not lose the remaining SVIP benefits). Invalid tiers are
     * ignored (keep the current one).
     */
    private void applyTier(PayMembership membership, String requestedTier,
                           boolean stillActive, long uid, String orderNo) {
        String requested = normalizeTier(requestedTier);
        if (requested == null) {
            return;
        }
        String current = membership.getId() == null ? null : normalizeTier(membership.getTier());
        if (stillActive && rank(current) > rank(requested)) {
            log.info("[PAY] tier_downgrade_blocked uid={} current={} requested={} order_no={}",
                    uid, current, requested, orderNo);
            audit.audit("TIER_DOWNGRADE_BLOCKED", "uid", uid, "current", current,
                    "requested", requested, "order_no", orderNo);
            return;
        }
        membership.setTier(requested);
    }

    private static String normalizeTier(String tier) {
        if (tier == null || tier.isBlank()) {
            return null;
        }
        String t = tier.trim().toUpperCase();
        return ("VIP".equals(t) || "SVIP".equals(t)) ? t : null;
    }

    private static int rank(String tier) {
        if (tier == null) {
            return 0;
        }
        return switch (tier) {
            case "SVIP" -> 2;
            case "VIP" -> 1;
            default -> 0;
        };
    }

    private void insertEvent(PayMembership membership, long uid, PayMembershipEvent.EventType type,
                             String orderNo, int days, LocalDateTime expireBefore, String reason,
                             String requestId) {
        PayMembershipEvent event = new PayMembershipEvent();
        event.setUid(uid);
        event.setType(type);
        event.setOrderNo(orderNo);
        event.setDays(days);
        event.setExpireBefore(expireBefore);
        event.setExpireAfter(membership.getExpireAt());
        event.setReason(reason);
        event.setRequestId(requestId);
        eventMapper.insert(event);
    }

    @Transactional(readOnly = true)
    public Optional<PayMembership> findByUid(long uid) {
        String cacheKey = MEMBERSHIP_CACHE_PREFIX + uid;
        PayMembership cached = cache.get(cacheKey, MEMBERSHIP_CACHE_TYPE);
        if (cached != null) {
            return Optional.of(cached);
        }
        PayMembership membership = membershipMapper.selectOne(
                new LambdaQueryWrapper<PayMembership>().eq(PayMembership::getUid, uid));
        if (membership != null) {
            cache.put(cacheKey, membership, MEMBERSHIP_CACHE_TTL);
        }
        return Optional.ofNullable(membership);
    }

    public boolean isActive(PayMembership membership) {
        return membership.getExpireAt().isAfter(LocalDateTime.now(clock));
    }

    /**
     * 当前生效档位的等级（FREE=0 / VIP=1 / SVIP=2；无会员或已过期 = 0）。
     * 下单时的重复购买拦截以此为准：等级 &gt;= 商品档位 → 拒绝（仅允许向上升级）。
     */
    @Transactional(readOnly = true)
    public int activeTierRank(long uid) {
        return findByUid(uid)
                .filter(this::isActive)
                .map(m -> rank(normalizeTier(m.getTier())))
                .orElse(0);
    }

    /**
     * 下单锁版本：FOR UPDATE 锁定会员行（无行则锁唯一索引间隙），把「查档位 → 建单」
     * 与并发的交付/升级/管理员补偿串行化 —— 恶意脚本并发下单无法在检查与建单之间
     * 插入一笔会改变档位的交付。
     */
    /**
     * FOR UPDATE 锁定会员行并返回实体（无行返回 null = FREE）。建单档位判定与
     * 升级基准解析（last_order_no）共用这一把锁：档位墙、升级换购与并发的交付/
     * 补偿在同一行上串行化。
     */
    @Transactional
    public PayMembership lockActiveMembershipForUpdate(long uid) {
        return membershipMapper.selectByUidForUpdate(uid);
    }
    @Transactional
    public int activeTierRankForUpdate(long uid) {
        // 复用锁定行计算档位（原实现锁定后再 findByUid 重查同一行，每单多一次往返）
        PayMembership locked = membershipMapper.selectByUidForUpdate(uid);
        if (locked == null) {
            return 0;
        }
        return isActive(locked) ? rank(normalizeTierStatic(locked.getTier())) : 0;
    }

    /** 档位等级（FREE=0 / VIP=1 / SVIP=2，未知档位按 0）。 */
    public static int tierRank(String tier) {
        return rank(normalizeTierStatic(tier));
    }

    private static String normalizeTierStatic(String tier) {
        if (tier == null || tier.isBlank()) {
            return null;
        }
        String t = tier.trim().toUpperCase();
        return ("VIP".equals(t) || "SVIP".equals(t)) ? t : null;
    }
}
