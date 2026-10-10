package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * Cross-instance lease for fallback jobs (mutual exclusion across replicas). name is the primary key; the lease can be taken over once locked_until passes.
 * The lease is an optimization to avoid duplicate outbound calls/duplicate processing; correctness is still guaranteed by the conditional updates on orders.
 */
@Getter
@Setter
@TableName("pay_job_lock")
public class PayJobLock {

    @TableId
    private String name;

    private String owner;

    private LocalDateTime lockedUntil;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
