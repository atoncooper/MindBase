package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
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

/**
 * 订单创建/查询。状态流转不在本类（见 PayOrderMapper 条件更新）。
 *
 * <p>事务边界用 TransactionTemplate 而非 @Transactional：事务只包幂等检查 + 落库，
 * 渠道预下单（HTTP）必须留在事务外——出站最坏 3s 超时不能占住池连接/延长锁持有；
 * 且事务方法若拆到同类私有方法，自调用会绕过 @Transactional 代理，程序化事务无此坑。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderService {

    private final PayOrderMapper orderMapper;
    private final ProductService productService;
    private final PayChannelRouter channelRouter;
    private final PayAuditLogger audit;
    private final AppTaskTimerClient timerClient;
    private final Clock clock;
    private final TransactionTemplate txTemplate;

    /** 创建结果：订单 + 前端支付参数（MOCK=确认端点；ALIPAY=扫码 qrCode）。 */
    public record CreatedOrder(PayOrder order, Map<String, Object> payParams) {
    }

    public CreatedOrder createOrder(long uid, String skuCode, PayOrder.PayChannel channel,
                                    String idempotencyKey) {
        // 渠道可用性先行校验（未启用/缺密钥在下单前拒绝），MOCK 无需适配器；无 DB 参与，置于事务外
        PayChannelAdapter adapter = channel == PayOrder.PayChannel.MOCK
                ? null : channelRouter.requireAdapter(channel);

        PayOrder order;
        try {
            order = txTemplate.execute(status -> createOrderTx(uid, skuCode, channel, idempotencyKey));
        } catch (DuplicateKeyException e) {
            // 唯一键兜底（并发同幂等键竞争 / 可忽略概率的订单号碰撞），见 recoverAfterDuplicateKey
            order = recoverAfterDuplicateKey(uid, idempotencyKey);
        }
        // 渠道取码（HTTP）在事务提交后执行：已落库订单取码失败时订单留 CREATED，
        // 重试命中幂等键重取（precreate 同单号同二维码），未取码订单由兜底超时关单——不回滚已创建订单
        return new CreatedOrder(order, buildPayParams(order, adapter));
    }

    /** 事务内核：幂等检查 + 商品快照落库 + 提交后注册超时委托。唯一写操作是 insert。 */
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
                // precreate 幂等（同单号同二维码），幂等命中重新取码安全
                return existing;
            }
        }

        PayProduct product = productService.requireActive(skuCode);
        LocalDateTime now = LocalDateTime.now(clock);

        PayOrder order = new PayOrder();
        order.setOrderNo(generateOrderNo());
        order.setUid(uid);
        order.setSkuCode(product.getCode());
        order.setProductTitle(product.getTitle());
        order.setDurationDays(product.getDurationDays());
        order.setAmountCents(product.getPriceCents());
        order.setChannel(channel);
        order.setExpiresAt(productService.expireAtFrom(now));
        order.setIdempotencyKey(idempotencyKey == null || idempotencyKey.isBlank() ? null : idempotencyKey.trim());
        order.setCreatedAt(now);
        orderMapper.insert(order);

        // 注册超时委托到 app-task（事务提交后执行；失败仅告警，兜底轮询接管，plan/1.0.8）
        timerClient.registerOrderTimeoutAfterCommit(uid, order.getOrderNo(),
                order.getVersion(), order.getExpiresAt());

        log.info("[PAY] order_created uid={} sku={} amount_cents={} expires_at={}",
                uid, order.getSkuCode(), order.getAmountCents(), order.getExpiresAt());
        audit.audit("ORDER_CREATED", "uid", uid, "order_no", order.getOrderNo(),
                "sku", order.getSkuCode(), "amount_cents", order.getAmountCents(),
                "channel", channel.name());
        return order;
    }

    /** 并发同幂等键落库竞争的兜底：重读命中即复用（语义同幂等命中）；他人占用/纯碰撞 → 409。 */
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

    /** 归属校验：非本人订单按 404 返回，防订单号枚举（IDOR）。 */
    public PayOrder getOwnedOrder(long uid, String orderNo) {
        PayOrder order = selectByOrderNo(orderNo);
        if (order == null || order.getUid() != uid) {
            throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
        }
        return order;
    }

    /** 用户最近订单（测试控制台概览用）。limit 为内部受控常量调用方传入。 */
    public List<PayOrder> listRecentByUid(long uid, int limit) {
        return orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .orderByDesc(PayOrder::getCreatedAt)
                .last("LIMIT " + limit));
    }

    private Map<String, Object> buildPayParams(PayOrder order, PayChannelAdapter adapter) {
        if (adapter != null) {
            return adapter.createPayment(order);
        }
        // M1 mock 渠道：前端调 confirmEndpoint 模拟支付成功
        return Map.of("type", "mock",
                "orderNo", order.getOrderNo(),
                "confirmEndpoint", "/pay/mock/confirm");
    }

    private PayOrder selectByOrderNo(String orderNo) {
        return orderMapper.selectOne(
                new LambdaQueryWrapper<PayOrder>().eq(PayOrder::getOrderNo, orderNo));
    }

    /** 128-bit UUID 碰撞概率可忽略，uk_pay_order_no 唯一键兜底（→ recoverAfterDuplicateKey）。 */
    private String generateOrderNo() {
        return "PO" + UUID.randomUUID().toString().replace("-", "");
    }
}
