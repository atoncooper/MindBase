package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/** Channel callback/notification log, retained for reconciliation and customer-dispute evidence. payload stores only masked text, never ciphertext or keys. */
@Getter
@Setter
@TableName("pay_callback_log")
public class PayCallbackLog {

    public enum SignatureResult {VALID, INVALID, SKIPPED}

    public enum HandleResult {ACCEPTED, ACCEPTED_DUPLICATE, IGNORED, ORDER_NOT_FOUND, ERROR}

    @TableId(type = IdType.AUTO)
    private Long id;

    private String orderNo;

    private PayOrder.PayChannel channel;

    private String payloadMasked;

    private SignatureResult signatureResult;

    private HandleResult handleResult;

    private String message;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();
}
