package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.TwoLevelCache;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayProductMapper;
import com.mindbase.pay.model.PayProduct;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;

/**
 * Active-product query over the authoritative {@code pay_product} catalog.
 *
 * <p>The catalog is owned by the database, not by this class: schema + one-shot
 * seed live in Flyway ({@code V1} table, {@code V11} idempotent seed), and the
 * console CRUD lives in app-admin ({@code /api/pay/products}). This service only
 * queries/serves; there is no startup seeding any more, so a redeploy can never
 * overwrite an operator-edited row.
 *
 * <p>Product data is tiny and changes rarely, but {@code GET /pay/products} and
 * every order creation used to query the DB. The catalog now goes through
 * {@link TwoLevelCache}: L1 local + optional shared Redis L2, 5s TTL. Console
 * edits (direct DB writes by app-admin) therefore become visible within that
 * TTL (or immediately after restart); this trade-off is intentional for a
 * read-only catalog. Orders/memberships are never cached here.
 */
@Service
@RequiredArgsConstructor
public class ProductService {

    private static final String ACTIVE_CACHE_KEY = "pay:cache:v1:product:active";
    private static final Duration PRODUCT_CACHE_TTL = Duration.ofSeconds(5);
    private static final TypeReference<List<PayProduct>> PRODUCT_LIST_TYPE =
            new TypeReference<>() {
            };

    private final PayProductMapper productMapper;
    private final PayProperties payProperties;
    private final TwoLevelCache cache;

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
