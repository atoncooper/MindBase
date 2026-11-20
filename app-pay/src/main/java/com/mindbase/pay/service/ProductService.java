package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.TwoLevelCache;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayProductMapper;
import com.mindbase.pay.model.PayProduct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;

/**
 * SKU seeding + active-product query.
 *
 * <p>Product data is tiny and changes rarely, but {@code GET /pay/products} and
 * every order creation used to query the DB. The catalog now goes through
 * {@link TwoLevelCache}: L1 local + optional shared Redis L2, 5s TTL.
 *
 * <p>Ops that change price/status directly in MySQL become visible within 5s
 * (or immediately after restart); this trade-off is intentional for a read-only
 * catalog. Orders/memberships are never cached here.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductService implements ApplicationRunner {

    private static final String ACTIVE_CACHE_KEY = "pay:cache:v1:product:active";
    private static final Duration PRODUCT_CACHE_TTL = Duration.ofSeconds(5);
    private static final TypeReference<List<PayProduct>> PRODUCT_LIST_TYPE =
            new TypeReference<>() {
            };

    private final PayProductMapper productMapper;
    private final PayProperties payProperties;
    private final TwoLevelCache cache;

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
        cache.evict(ACTIVE_CACHE_KEY);
    }

    public List<PayProduct> listActive() {
        List<PayProduct> cached = cache.get(ACTIVE_CACHE_KEY, PRODUCT_LIST_TYPE);
        if (cached != null) {
            return cached;
        }

        List<PayProduct> products = productMapper.selectList(new LambdaQueryWrapper<PayProduct>()
                .eq(PayProduct::getStatus, PayProduct.ProductStatus.ACTIVE)
                .orderByAsc(PayProduct::getSort)
                .orderByAsc(PayProduct::getId));
        List<PayProduct> immutable = List.copyOf(products);
        cache.put(ACTIVE_CACHE_KEY, immutable, PRODUCT_CACHE_TTL);
        return immutable;
    }

    public PayProduct requireActive(String skuCode) {
        for (PayProduct product : listActive()) {
            if (product.getCode().equals(skuCode)) {
                return product;
            }
        }
        // Unknown/disabled SKU: fall through to DB so the error semantics stay exact.
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
