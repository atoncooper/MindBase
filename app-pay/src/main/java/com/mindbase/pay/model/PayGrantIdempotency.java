package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * ADMIN_GRANT 幂等占位（request_id 主键）。先占位再执行会员扩展，二者同事务：
 * 成功一起提交；失败一起回滚（可安全重试）。并发重放命中主键冲突 = 幂等命中。
 */
@Getter
@Setter
@TableName("pay_grant_idempotency")
public class PayGrantIdempotency {

    @TableId(type = IdType.INPUT)
    private String requestId;

    private long uid;

    private LocalDateTime createdAt;
}
