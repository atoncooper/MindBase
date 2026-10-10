package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayProductMapper;
import com.mindbase.pay.model.PayProduct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;

/**
 * SKU seeding + active-product query. Seeds are inserted only when missing and never overwrite operational changes
 * to price/status; prices are placeholders (plan/1.0.7-Pay §13-4) to be updated directly in the DB or in this list
 * once operations signs off.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductService implements ApplicationRunner {

    private final PayProductMapper productMapper;
    private final PayProperties payProperties;

    private static final List<PayProduct> DEFAULT_SKUS = List.of(
            sku("VIP_MONTHLY", "Membership · Monthly", 30, 1800, 10, "VIP"),
            sku("VIP_QUARTERLY", "Membership · Quarterly", 90, 4500, 20, "VIP"),
            sku("VIP_YEARLY", "Membership · Yearly", 365, 15800, 30, "VIP"),
            sku("SVIP_MONTHLY", "Super Membership · Monthly", 30, 4800, 40, "SVIP"),
            sku("SVIP_QUARTERLY", "Super Membership · Quarterly", 90, 12000, 50, "SVIP"),
            sku("SVIP_YEARLY", "Super Membership · Yearly", 365, 42000, 60, "SVIP")
    );

    private static PayProduct sku(String code, String title, int days, long priceCents, int sort, String tier) {
        PayProduct p = new PayProduct();
        p.setCode(code);
        p.setTitle(title);
        p.setDurationDays(days);
        p.setPriceCents(priceCents);
        p.setSort(sort);
        p.setTier(tier);
        p.setStatus(PayProduct.ProductStatus.ACTIVE);
        return p;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (PayProduct sku : DEFAULT_SKUS) {
            Long count = productMapper.selectCount(
                    new LambdaQueryWrapper<PayProduct>().eq(PayProduct::getCode, sku.getCode()));
            if (count == null || count == 0) {
                productMapper.insert(sku);
                log.info("[PAY] seed_product code={} price_cents={} days={}",
                        sku.getCode(), sku.getPriceCents(), sku.getDurationDays());
            }
        }
    }

    public List<PayProduct> listActive() {
        return productMapper.selectList(new LambdaQueryWrapper<PayProduct>()
                .eq(PayProduct::getStatus, PayProduct.ProductStatus.ACTIVE)
                .orderByAsc(PayProduct::getSort)
                .orderByAsc(PayProduct::getId));
    }

    public PayProduct requireActive(String skuCode) {
        PayProduct product = productMapper.selectOne(
                new LambdaQueryWrapper<PayProduct>().eq(PayProduct::getCode, skuCode));
        if (product == null) {
            throw ApiException.notFound("SKU_NOT_FOUND", "SKU not found");
        }
        if (product.getStatus() != PayProduct.ProductStatus.ACTIVE) {
            throw ApiException.badRequest("SKU_DISABLED", "SKU is disabled");
        }
        return product;
    }

    /** Single entry point for the order payment deadline, for easier testing and global adjustment. */
    public LocalDateTime expireAtFrom(LocalDateTime createdAt) {
        return createdAt.plusMinutes(payProperties.order().timeoutMinutes());
    }
}
