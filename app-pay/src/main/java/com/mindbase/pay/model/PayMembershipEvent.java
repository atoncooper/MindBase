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

    /** 运营补偿幂等键：同一 request_id 只落一条事件、只生效一次（唯一索引兜底并发重放）。 */
    private String requestId;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();
}
