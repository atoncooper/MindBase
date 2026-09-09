package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * 会员实例，uid 唯一（对应主 app users.uid，跨库不建外键）。
 * 到期判断是懒过期：active = expire_at > now，不依赖定时任务翻转状态。
 */
@Getter
@Setter
@TableName("pay_membership")
public class PayMembership {

    @TableId(type = IdType.AUTO)
    private Long id;

    private long uid;

    // 一期固定 VIP；后续多档会员扩展此字段
    private String tier = "VIP";

    private LocalDateTime expireAt;

    // 连续订阅一期不做，仅预留
    private boolean autoRenew = false;

    private String lastOrderNo;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
