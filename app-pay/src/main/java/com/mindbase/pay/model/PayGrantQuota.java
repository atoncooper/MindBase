package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * ADMIN_GRANT 日额度计数（主键 = 本地自然日）。补偿开通的额度校验从
 * “事务外 count/sum”改为“事务内 SELECT ... FOR UPDATE + 原子累加”，
 * 并发请求无法再超额开通。
 */
@Getter
@Setter
@TableName("pay_grant_quota")
public class PayGrantQuota {

    @TableId(type = IdType.INPUT)
    private LocalDate day;

    /** 当日 ADMIN_GRANT 次数。 */
    private int cnt;

    /** 当日 ADMIN_GRANT 总天数。 */
    private int days;

    private LocalDateTime updatedAt;
}
