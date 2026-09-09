package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayMembership;
import org.apache.ibatis.annotations.Param;

/**
 * 会员 Mapper。BaseMapper 内置单表 CRUD；手写 SQL（行锁查询）
 * 在 resources/mapper/PayMembershipMapper.xml。
 */
public interface PayMembershipMapper extends BaseMapper<PayMembership> {

    /** 顺延计算前先锁会员行（FOR UPDATE），串行化同一用户并发交付。 */
    PayMembership selectByUidForUpdate(@Param("uid") long uid);
}
