package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayGrantIdempotency;

/** ADMIN_GRANT 幂等占位：BaseMapper.insert 的主键冲突即“已处理过”。 */
public interface PayGrantIdempotencyMapper extends BaseMapper<PayGrantIdempotency> {
}
