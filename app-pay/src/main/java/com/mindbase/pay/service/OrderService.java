package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
import com.mindbase.pay.service.channel.ChannelQueryResult;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.timer.AppTaskTimerClient;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Order creation/query/cancellation. State transitions are not in this class (see the conditional updates in
 * PayOrderMapper).
 *
 * <p>The transaction boundary uses TransactionTemplate instead of @Transactional: the transaction covers only the
 * idempotency check + insert, while the channel pre-order (HTTP) must stay outside it -- a worst-case 3s outbound
 * timeout must not hold a pool connection / extend lock duration. Also, splitting a transactional method into a
 * private method of the same class lets self-invocation bypass the @Transactional proxy, which programmatic
 * transactions avoid.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderService {

    private final PayOrderMapper orderMapper;
    private final ProductService productService;
    private final MembershipService membershipService;
    private final PayChannelRouter channelRouter;
    private final PaymentService paymentService;
    private final PayAuditLogger audit;
    private final AppTaskTimerClient timerClient;
    private final PayMetrics metrics;
    private final PayProperties payProperties;
    private final Clock clock;
    private final TransactionTemplate txTemplate;

    /** 订单读取时的渠道实时查单节流（同单 ≥3s 一次；单实例内存态，多实例仅多做几次幂等查询）。 */
    private static final ConcurrentHashMap<String, Long> LAST_CHANNEL_QUERY = new ConcurrentHashMap<>();

    /** Creation result: order + frontend payment params (MOCK = confirm endpoint; ALIPAY = scan qrCode). */
    public record CreatedOrder(PayOrder order, Map<String, Object> payParams) {
    }

    public CreatedOrder createOrder(long uid, String skuCode, PayOrder.PayChannel channel,
                                    String idempotencyKey) {
        // Channel availability is checked first: **all channels go through the router** (including MOCK).
        // Previously a special case skipped the adapter for MOCK, so production (mock.enabled=false) could still
        // create orders that could never be paid.
        PayChannelAdapter adapter = channelRouter.requireAdapter(channel);

        PayOrder order;
        try {
            order = txTemplate.execute(status -> createOrderTx(uid, skuCode, channel, idempotencyKey));
        } catch (DuplicateKeyException e) {
            // Unique-key backstop (concurrent race on the same idempotency key / negligible-probability order-number collision), see recoverAfterDuplicateKey
            order = recoverAfterDuplicateKey(uid, idempotencyKey);
        }
        // Channel code acquisition (HTTP) runs after the transaction commits: if it fails for a persisted order,
        // the order stays CREATED and a retry hits the idempotency key to fetch the code again (precreate returns
        // the same QR for the same order number); orders without a code are closed by the fallback timeout --
        // a created order is never rolled back
        return new CreatedOrder(order, adapter.createPayment(order));
    }

    /** Transaction core: idempotency check + unpaid order cap + product snapshot insert + post-commit timeout registration. */
    private PayOrder createOrderTx(long uid, String skuCode, PayOrder.PayChannel channel,
                                   String idempotencyKey) {
        if (idempotencyKey != null && !idempotencyKey.isBlank()) {
            PayOrder existing = orderMapper.selectOne(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getIdempotencyKey, idempotencyKey.trim()));
            if (existing != null) {
                if (existing.getUid() != uid) {
                    throw ApiException.conflict("IDEMPOTENCY_CONFLICT", "Idempotency key already taken by another user");
                }
                log.info("[PAY] order_idempotent_hit uid={} order_no={}", uid, existing.getOrderNo());
                // precreate is idempotent (same order number, same QR), so re-fetching the code on an idempotent hit is safe
                return existing;
            }
        }

        PayProduct product = productService.requireActive(skuCode);
        LocalDateTime now = LocalDateTime.now(clock);

        // 防重复购买：生效会员档位 &gt;= 商品档位 → 拒绝下单（仅允许向上升级）。
        // 交付层的 applyTier 只是不降级写入，这里在扣款之前就拦住，避免用户
        // 为不会被应用的权益付费。
        int currentRank = membershipService.activeTierRankForUpdate(uid);
        int productRank = MembershipService.tierRank(product.getTier());
        if (currentRank >= productRank) {
            String currentTier = currentRank == 2 ? "SVIP" : currentRank == 1 ? "VIP" : "FREE";
            audit.audit("PURCHASE_TIER_BLOCKED", "uid", uid, "current", currentTier,
                    "sku", product.getCode(), "product_tier", product.getTier());
            log.info("[PAY] purchase_tier_blocked uid={} current={} sku={} product_tier={}",
                    uid, currentTier, product.getCode(), product.getTier());
            throw ApiException.conflict("TIER_DOWNGRADE_BLOCKED",
                    "当前 " + currentTier + " 会员有效期内不可重复购买，仅支持向上升级更高档位");
        }

        enforceOpenOrderLimit(uid, now);

        PayOrder order = new PayOrder();
        order.setOrderNo(generateOrderNo());
        order.setUid(uid);
        order.setSkuCode(product.getCode());
        order.setProductTitle(product.getTitle());
        order.setDurationDays(product.getDurationDays());
        order.setAmountCents(product.getPriceCents());
        order.setTier(product.getTier());
        order.setChannel(channel);
        order.setExpiresAt(productService.expireAtFrom(now));
        order.setIdempotencyKey(idempotencyKey == null || idempotencyKey.isBlank() ? null : idempotencyKey.trim());
        order.setCreatedAt(now);
        orderMapper.insert(order);

        // Register the timeout delegation with app-task (runs after commit; failures only warn and fallback polling takes over, plan/1.0.8)
        timerClient.registerOrderTimeoutAfterCommit(uid, order.getOrderNo(),
                order.getVersion(), order.getExpiresAt());

        metrics.orderCreated();
        log.info("[PAY] order_created uid={} sku={} amount_cents={} expires_at={}",
                uid, order.getSkuCode(), order.getAmountCents(), order.getExpiresAt());
        audit.audit("ORDER_CREATED", "uid", uid, "order_no", order.getOrderNo(),
                "sku", order.getSkuCode(), "amount_cents", order.getAmountCents(),
                "channel", channel.name());
        return order;
    }

    /** Unpaid order cap: prevents order-spam from filling the DB (over the limit returns 429; callers back off and retry or pay/cancel first). */
    private void enforceOpenOrderLimit(long uid, LocalDateTime now) {
        int max = payProperties.order().maxOpenPerUser();
        if (max <= 0) {
            return;
        }
        Long open = orderMapper.selectCount(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                .gt(PayOrder::getExpiresAt, now));
        if (open != null && open >= max) {
            log.warn("[PAY] open_order_limit_hit uid={} open={} max={}", uid, open, max);
            throw ApiException.tooManyRequests("TOO_MANY_OPEN_ORDERS",
                    "Too many unpaid orders, please pay or cancel before creating a new one");
        }
    }

    /** Fallback for a concurrent race on the same idempotency key: a re-read hit is reused (same semantics as an idempotent hit); another user's key / pure collision -> 409. */
    private PayOrder recoverAfterDuplicateKey(long uid, String idempotencyKey) {
        if (idempotencyKey != null && !idempotencyKey.isBlank()) {
            PayOrder existing = orderMapper.selectOne(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getIdempotencyKey, idempotencyKey.trim()));
            if (existing != null) {
                if (existing.getUid() != uid) {
                    throw ApiException.conflict("IDEMPOTENCY_CONFLICT", "Idempotency key already taken by another user");
                }
                log.info("[PAY] order_idempotent_race_recovered uid={} order_no={}",
                        uid, existing.getOrderNo());
                return existing;
            }
        }
        throw ApiException.conflict("ORDER_NO_COLLISION", "Order number collision, please retry");
    }

    /**
     * Re-fetches the order's payment params (M2 Alipay: scan QR). precreate is idempotent (same order number,
     * same QR) and backs both refreshing the payment code of a pending order and the frontend QR image endpoint.
     */
    public Map<String, Object> paymentParams(PayOrder order) {
        return channelRouter.requireAdapter(order.getChannel()).createPayment(order);
    }

    /** User cancels an unpaid order (CREATED only; the conditional update arbitrates concurrency). */
    public PayOrder cancelOrder(long uid, String orderNo) {
        PayOrder order = getOwnedOrder(uid, orderNo);
        if (order.getStatus() != PayOrder.OrderStatus.CREATED) {
            throw ApiException.conflict("ORDER_NOT_CANCELLABLE",
                    "Order is not cancellable in current state: " + order.getStatus());
        }
        LocalDateTime now = LocalDateTime.now(clock);
        int cancelled = orderMapper.closeOrder(orderNo, now, "USER_CANCELLED");
        if (cancelled == 0) {
            throw ApiException.conflict("ORDER_STATE_INVALID", "Order state changed, please refresh");
        }
        metrics.orderClosed("user");
        audit.audit("ORDER_CANCELLED", "uid", uid, "order_no", orderNo);
        log.info("[PAY] order_cancelled uid={} order_no={}", uid, orderNo);
        return selectByOrderNo(orderNo);
    }

    /** Ownership check: another user's order is returned as 404 to prevent order-number enumeration (IDOR). */
    public PayOrder getOwnedOrder(long uid, String orderNo) {
        PayOrder order = selectByOrderNo(orderNo);
        if (order == null || order.getUid() != uid) {
            throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
        }
        return order;
    }

    /**
     * 订单详情（实时查单版）：CREATED 的非 MOCK 订单在读取时向渠道实时确认一次
     * （同单 3 秒节流）。用户扫码支付后，二维码弹窗的 2.5s 轮询会在下一拍立即
     * 确认并开通 —— 不再依赖后台查单任务的周期，也不依赖公网异步回调。
     */
    public PayOrder getOwnedOrderLive(long uid, String orderNo) {
        PayOrder order = getOwnedOrder(uid, orderNo);
        if (order.getStatus() != PayOrder.OrderStatus.CREATED
                || order.getChannel() == PayOrder.PayChannel.MOCK) {
            return order;
        }
        long now = System.currentTimeMillis();
        Long last = LAST_CHANNEL_QUERY.get(orderNo);
        if (last != null && now - last < 3000L) {
            return order;
        }
        LAST_CHANNEL_QUERY.put(orderNo, now);
        try {
            PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
            ChannelQueryResult result = adapter.queryOrder(order);
            if (result.status() == ChannelQueryResult.Status.PAID) {
                paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                        result.tradeNo(), result.paidAmountCents(),
                        "{\"source\":\"order_read_sync\"}", PayCallbackLog.SignatureResult.VALID,
                        result.buyerLogonId(), result.buyerUserId());
            }
        } catch (Exception e) {
            log.warn("[PAY] order_read_sync_failed order_no={}", orderNo, e);
        }
        return selectByOrderNo(orderNo);
    }

    /** Current user's orders (newest first, uses idx_pay_order_uid_status). */
    public List<PayOrder> listOwnedOrders(long uid, int limit) {
        return orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .orderByDesc(PayOrder::getCreatedAt)
                .last("LIMIT " + Math.max(1, limit)));
    }

    /** User's most recent orders (for the test console overview). limit is passed by the caller as an internal controlled constant. */
    public List<PayOrder> listRecentByUid(long uid, int limit) {
        return listOwnedOrders(uid, limit);
    }

    private PayOrder selectByOrderNo(String orderNo) {
        return orderMapper.selectOne(
                new LambdaQueryWrapper<PayOrder>().eq(PayOrder::getOrderNo, orderNo));
    }

    /** A 128-bit UUID collision is negligible, with the uk_pay_order_no unique key as the backstop (-> recoverAfterDuplicateKey). */
    private String generateOrderNo() {
        return "PO" + UUID.randomUUID().toString().replace("-", "");
    }
}
