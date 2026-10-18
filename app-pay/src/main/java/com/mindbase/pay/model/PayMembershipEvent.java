package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/** Audit event stream for entitlement changes: activation/extension/compensation are all traceable (reconciliation and customer-dispute evidence). */
@Getter
@Setter
@TableName("pay_membership_event")
public class PayMembershipEvent {

    public enum EventType {ACTIVATE, RENEW, ADMIN_GRANT, REFUND_REVOKE, UPGRADE}

    @TableId(type = IdType.AUTO)
    private Long id;

    private long uid;

    private EventType type;

    private String orderNo;

    private int days;

    private LocalDateTime expireBefore;

    private LocalDateTime expireAfter;

    private String reason;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();
}
