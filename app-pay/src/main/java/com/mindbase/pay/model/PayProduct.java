package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/** Membership SKU. Prices are always long cents; floating point is forbidden. Camel-case fields map automatically to underscore table columns (tables created by Flyway migrations). */
@Getter
@Setter
@TableName("pay_product")
public class PayProduct {

    public enum ProductStatus {ACTIVE, DISABLED}

    @TableId(type = IdType.AUTO)
    private Long id;

    private String code;

    private String title;

    private int durationDays;

    private long priceCents;

    /** Entitlement tier (VIP|SVIP): explicit column, replacing tier inference from the code prefix string. */
    private String tier = "VIP";

    private ProductStatus status = ProductStatus.ACTIVE;

    private int sort;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
