package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/** 会员 SKU。价格一律 long 分，禁止浮点。字段驼峰自动映射表下划线列（schema.sql 建表）。 */
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

    private ProductStatus status = ProductStatus.ACTIVE;

    private int sort;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
