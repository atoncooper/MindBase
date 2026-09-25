package com.mindbase.pay.controller;

import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.service.MembershipService;
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

/**
 * 内部端点（/internal/pay/*）。APISIX key-auth（consumer internal）保护，
 * 调用方：主 app 权益消费（M3）、运营补偿。
 */
@Slf4j
@RestController
@RequestMapping("/internal/pay")
@RequiredArgsConstructor
public class PayInternalController {

    private final MembershipService membershipService;

    /** 非会员返回 active=false 而非 404，主 app 无需判空。 */
    @GetMapping("/membership/{uid}")
    public InternalMembershipView membership(@PathVariable long uid) {
        return membershipService.findByUid(uid)
                .map(m -> new InternalMembershipView(uid, m.getTier(),
                        membershipService.isActive(m), m.getExpireAt()))
                .orElse(new InternalMembershipView(uid, null, false, null));
    }

    /** 运营补偿开通/延期：reason 必填并落 ADMIN_GRANT 审计事件。 */
    @PostMapping("/grant")
    public MembershipView grant(@Valid @RequestBody GrantRequest req) {
        // tier optional: blank = keep existing/default; only VIP|SVIP accepted
        String tier = req.tier() == null || req.tier().isBlank() ? null : req.tier().trim().toUpperCase();
        if (tier != null && !"VIP".equals(tier) && !"SVIP".equals(tier)) {
            throw new IllegalArgumentException("tier must be VIP or SVIP");
        }
        log.info("[PAY] admin_grant uid={} days={} tier={} reason={}",
                req.uid(), req.durationDays(), tier, req.reason());
        PayMembership membership = membershipService.extend(req.uid(), req.durationDays(), null,
                PayMembershipEvent.EventType.ADMIN_GRANT, req.reason(), tier);
        return MembershipView.from(membership, membershipService.isActive(membership));
    }
}
