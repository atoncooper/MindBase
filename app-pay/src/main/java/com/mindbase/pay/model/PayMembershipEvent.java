package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/** 权益变更审计事件流：开通/顺延/补偿均可追溯（对账与客诉取证）。 */
@Getter
@Setter
@TableName("pay_membership_event")
public class PayMembershipEvent {

    public enum EventType {ACTIVATE, RENEW, ADMIN_GRANT, REFUND_REVOKE}

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
