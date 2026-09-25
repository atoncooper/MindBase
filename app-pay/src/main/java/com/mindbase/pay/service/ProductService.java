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
 * SKU 种子 + 在售查询。种子仅在缺失时插入，不覆盖运营侧对价格/状态的修改；
 * 价格为占位值（plan/1.0.7-Pay §13-4），运营确认后直接改库或改此清单。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductService implements ApplicationRunner {

    private final PayProductMapper productMapper;
    private final PayProperties payProperties;

    private static final List<PayProduct> DEFAULT_SKUS = List.of(
            sku("VIP_MONTHLY", "会员·月度", 30, 1800, 10),
            sku("VIP_QUARTERLY", "会员·季度", 90, 4500, 20),
            sku("VIP_YEARLY", "会员·年度", 365, 15800, 30),
            sku("SVIP_MONTHLY", "超级会员·月度", 30, 4800, 40),
            sku("SVIP_QUARTERLY", "超级会员·季度", 90, 12000, 50),
            sku("SVIP_YEARLY", "超级会员·年度", 365, 42000, 60)
    );

    private static PayProduct sku(String code, String title, int days, long priceCents, int sort) {
        PayProduct p = new PayProduct();
        p.setCode(code);
        p.setTitle(title);
        p.setDurationDays(days);
        p.setPriceCents(priceCents);
        p.setSort(sort);
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

    /** 订单支付截止时间统一入口，便于测试与全局调整。 */
    public LocalDateTime expireAtFrom(LocalDateTime createdAt) {
        return createdAt.plusMinutes(payProperties.order().timeoutMinutes());
    }
}
