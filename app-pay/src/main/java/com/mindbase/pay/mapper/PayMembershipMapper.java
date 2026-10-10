package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayMembership;
import org.apache.ibatis.annotations.Param;

/**
 * Membership Mapper. BaseMapper provides built-in single-table CRUD; hand-written SQL (row-lock query)
 * lives in resources/mapper/PayMembershipMapper.xml.
 */
public interface PayMembershipMapper extends BaseMapper<PayMembership> {

    /** Lock the membership row (FOR UPDATE) before extension calculation, serializing concurrent delivery for the same user. */
    PayMembership selectByUidForUpdate(@Param("uid") long uid);
}
