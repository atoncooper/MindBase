package com.mindbase.pay.controller;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.dto.PayDtos;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayRefundApproval;
import com.mindbase.pay.service.GrantQuotaService;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.RefundService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

import static com.mindbase.pay.dto.PayDtos.GrantRequest;
import static com.mindbase.pay.dto.PayDtos.InternalMembershipView;
import static com.mindbase.pay.dto.PayDtos.MembershipView;
import static com.mindbase.pay.dto.PayDtos.OrderView;
import static com.mindbase.pay.dto.PayDtos.RefundRequest;
import static com.mindbase.pay.dto.PayDtos.RejectRefundRequest;

/**
 * Internal endpoints (/internal/pay/*), protected by APISIX key-auth. 网关侧已按 consumer 分权：
 * membership 读 = 共享 internal / pay-readonly；grant 与 refund = 仅 pay-ops（见 apisix.yaml）。
 * Callers: main app membership consumption (M3), operations compensation, operations refund.
 */
@Slf4j
@Validated
@RestController
@RequestMapping("/internal/pay")
@RequiredArgsConstructor
public class PayInternalController {

    private final MembershipService membershipService;
    private final RefundService refundService;
    private final GrantQuotaService grantQuotaService;

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
        // ADMIN_GRANT 日额度熔断：超限 429 + 审计，防内部密钥泄漏后批量补偿薅会员
        grantQuotaService.checkDailyQuota(req.durationDays());
        log.info("[PAY] admin_grant uid={} days={} tier={} reason={}",
                req.uid(), req.durationDays(), tier, req.reason());
        PayMembership membership = membershipService.extend(req.uid(), req.durationDays(), null,
                PayMembershipEvent.EventType.ADMIN_GRANT, req.reason(), tier);
        return MembershipView.from(membership, membershipService.isActive(membership));
    }

    /**
     * Operations refund (M4 reverse flow) with maker-checker: require-approval=true（生产）时
     * 第一次调用只登记 PENDING 审批（operator=maker），必须由第二操作人（服务端强制 != maker）
     * 携 confirm=true 再次调用才执行渠道退款；审批留痕见 pay_refund_approval。
     * Idempotent -- a repeated call on an already refunded order returns immediately; an order
     * stuck in REFUNDING (crash/timeout) can be replayed to continue.
     */
    @PostMapping("/orders/{orderNo}/refund")
    public OrderView refund(@PathVariable @Pattern(regexp = "^PO[A-Za-z0-9]{1,62}$",
                                    message = "invalid orderNo") String orderNo,
                            @Valid @RequestBody RefundRequest req) {
        boolean revokeMembership = req.revokeMembership() == null || req.revokeMembership();
        boolean confirm = Boolean.TRUE.equals(req.confirm());
        log.info("[PAY] admin_refund order_no={} revoke_membership={} confirm={} operator={} reason={}",
                orderNo, revokeMembership, confirm, req.operator(), req.reason());
        PayOrder order = refundService.refundByOps(orderNo, req.reason(), revokeMembership,
                req.operator(), confirm);
        return OrderView.from(order);
    }

    /** Reject a pending refund request (second person; server-side enforced != maker). */
    @PostMapping("/orders/{orderNo}/refund/reject")
    public OrderView rejectRefund(@PathVariable @Pattern(regexp = "^PO[A-Za-z0-9]{1,62}$",
                                          message = "invalid orderNo") String orderNo,
                                  @Valid @RequestBody RejectRefundRequest req) {
        log.info("[PAY] admin_refund_reject order_no={} operator={}", orderNo, req.operator());
        PayOrder order = refundService.rejectRefundRequest(orderNo, req.operator());
        return OrderView.from(order);
    }

    /** Ops visibility over refund approvals (default: PENDING). */
    @GetMapping("/refund-requests")
    public List<PayRefundApproval> refundRequests(
            @RequestParam(value = "status", defaultValue = "PENDING") @Size(max = 20) String status) {
        return refundService.listRefundRequests(status);
    }
}
