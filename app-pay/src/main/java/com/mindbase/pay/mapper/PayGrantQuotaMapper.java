package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayGrantQuota;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * ADMIN_GRANT 日额度原子计数。手写 SQL 在 resources/mapper/PayGrantQuotaMapper.xml：
 * ensureDay（幂等建行）-> lockDay（FOR UPDATE 串行化同一天的所有补偿开通）-> consume（累加）。
 */
public interface PayGrantQuotaMapper extends BaseMapper<PayGrantQuota> {

    /** 幂等确保当天计数行存在（并发首次调用由 ON DUPLICATE KEY UPDATE 收敛为一行）。 */
    int ensureDay(@Param("day") LocalDate day, @Param("now") LocalDateTime now);

    /** 锁定当天计数行；调用方必须在事务内使用，锁持有到事务提交。 */
    PayGrantQuota lockDay(@Param("day") LocalDate day);

    /** 在已锁定并校验通过后累加一次开通（cnt + 1 / days + addDays）。 */
    int consume(@Param("day") LocalDate day, @Param("addDays") int addDays,
                @Param("now") LocalDateTime now);
}
