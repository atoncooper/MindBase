package com.mindbase.pay.controller;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.dto.PayDtos;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.RefundService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import static com.mindbase.pay.dto.PayDtos.GrantRequest;
import static com.mindbase.pay.dto.PayDtos.InternalMembershipView;
import static com.mindbase.pay.dto.PayDtos.MembershipView;
import static com.mindbase.pay.dto.PayDtos.OrderView;
import static com.mindbase.pay.dto.PayDtos.RefundRequest;

/**
 * Internal endpoints (/internal/pay/*), protected by APISIX key-auth (consumer internal).
 * Callers: main app membership consumption (M3), operations compensation, operations refund.
 */
@Slf4j
@RestController
@RequestMapping("/internal/pay")
@RequiredArgsConstructor
public class PayInternalController {

    private final MembershipService membershipService;
    private final RefundService refundService;

    /** A non-member returns active=false instead of 404, so the main app needs no null checks. */
    @GetMapping("/membership/{uid}")
    public InternalMembershipView membership(@PathVariable long uid) {
        return membershipService.findByUid(uid)
                .map(m -> new InternalMembershipView(uid, m.getTier(),
                        membershipService.isActive(m), m.getExpireAt()))
                .orElse(new InternalMembershipView(uid, null, false, null));
    }

    /** Operations compensation activation/extension: reason is required and recorded as an ADMIN_GRANT audit event. */
    @PostMapping("/grant")
    public MembershipView grant(@Valid @RequestBody GrantRequest req) {
        // tier optional: blank = keep existing/default; only VIP|SVIP accepted
        String tier = req.tier() == null || req.tier().isBlank() ? null : req.tier().trim().toUpperCase();
        if (tier != null && !"VIP".equals(tier) && !"SVIP".equals(tier)) {
            // 400 contract error (previously an IllegalArgumentException was swallowed into a 500, polluting 5xx monitoring)
            throw ApiException.badRequest("INVALID_TIER", "tier must be VIP or SVIP");
        }
        log.info("[PAY] admin_grant uid={} days={} tier={} reason={}",
                req.uid(), req.durationDays(), tier, req.reason());
        PayMembership membership = membershipService.extend(req.uid(), req.durationDays(), null,
                PayMembershipEvent.EventType.ADMIN_GRANT, req.reason(), tier);
        return MembershipView.from(membership, membershipService.isActive(membership));
    }

    /**
     * Operations refund (M4 reverse flow): channel refund + optional membership revocation.
     * Idempotent -- a repeated call on an already refunded order returns immediately; an order
     * stuck in REFUNDING (crash/timeout) can be replayed to continue.
     */
    @PostMapping("/orders/{orderNo}/refund")
    public OrderView refund(@PathVariable String orderNo,
                            @Valid @RequestBody RefundRequest req) {
        boolean revokeMembership = req.revokeMembership() == null || req.revokeMembership();
        log.info("[PAY] admin_refund order_no={} revoke_membership={} reason={}",
                orderNo, revokeMembership, req.reason());
        PayOrder order = refundService.refund(orderNo, req.reason(), revokeMembership);
        return OrderView.from(order);
    }
}
