package com.mindbase.pay.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.mindbase.pay.model.PayRefundApproval;

/** 退款审批记录：BaseMapper CRUD 已足够（审批查询按 order_no/status 走 LambdaWrapper + 索引）。 */
public interface PayRefundApprovalMapper extends BaseMapper<PayRefundApproval> {
}
