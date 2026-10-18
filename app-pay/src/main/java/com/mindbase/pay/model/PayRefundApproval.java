package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * 退款双人复核请求（maker-checker）：refund 端点的第一次调用登记 PENDING（maker），
 * 由第二操作人 confirm（checker，服务端强制 != maker）后放行进既有退款状态机。
 * 只做审批留痕，不动订单状态机 —— 订单在获批前保持 PAID/DELIVERED。
 */
@Getter
@Setter
@TableName("pay_refund_approval")
public class PayRefundApproval {

    public enum ApprovalStatus {PENDING, APPROVED, REJECTED}

    @TableId(type = IdType.AUTO)
    private Long id;

    private String orderNo;

    /** 发起人（第一次调用的 operator）。 */
    private String maker;

    private String makerReason;

    private ApprovalStatus status;

    /** 复核人（confirm/reject 调用的 operator，必须 != maker）。 */
    private String checker;

    private String checkReason;

    private LocalDateTime createdAt;

    private LocalDateTime decidedAt;
}
