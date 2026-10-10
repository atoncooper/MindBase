package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * Membership instance, uid unique (maps to users.uid in the main app; no cross-database foreign key).
 * Expiry is evaluated lazily: active = expire_at > now, without relying on a scheduled job to flip status.
 */
@Getter
@Setter
@TableName("pay_membership")
public class PayMembership {

    @TableId(type = IdType.AUTO)
    private Long id;

    private long uid;

    // Fixed to VIP in phase one; this field will be extended for multi-tier memberships
    private String tier = "VIP";

    private LocalDateTime expireAt;

    // Recurring subscription is not implemented in phase one; reserved only
    private boolean autoRenew = false;

    private String lastOrderNo;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
