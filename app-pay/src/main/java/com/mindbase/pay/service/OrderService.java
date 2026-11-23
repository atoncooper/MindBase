package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import static com.mindbase.pay.dto.PayDtos.UpgradeQuote;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PaidOrderSummary;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayMembership;
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
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Order creation/query/cancellation. State transitions are not in this class (see the conditional updates in
 * PayOrderMapper).
 *
 * <p>The transaction boundary uses TransactionTemplate instead of @Transactional: the transaction covers only the
 * idempotency check + insert, while the channel pre-order (HTTP) must stay outside it -- a worst-case 3s outbound
 * timeout must not hold a pool connection / extend lock duration. Also, splitting a transactional method into a
 * private method of the same class lets self-invocation bypass the @Transactional proxy, which programmatic
 * transactions avoid.
 *
 * <p><b>P0/P1 加固（2026-11）</b>：
 * <ul>
 *   <li>未支付订单上限改由数据库唯一槽位（pay_order.open_slot）保证，并发建单不能再用
 *       “先 count 再 insert”的竞态绕过 max-open-per-user；</li>
 *   <li>渠道出网并发闸门（信号量）：渠道变慢时保护 Tomcat 线程与支付宝配额，超时 429 快速失败；</li>
 *   <li>precreate 结果按订单短缓存（5 分钟）：/pay/orders/{no}/qr 不再每次请求都打渠道；</li>
 *   <li>内存冷却表清理从 O(n) 扫描改为整体清空（避免 10 万条目时在请求线程做全表扫描）。</li>
 * </ul>
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

    /**
     * 订单读取时的渠道实时查单节流（退避版）：同单第 n+1 次查单需距上次 ≥ min(3000×2^n, 24000)ms，
     * 即 3s→6s→12s→24s 封顶 —— 前端 2.5s 固定轮询在服务端被指数退避，1000 并发支付者的渠道查询
     * QPS 约 330 → 40。单实例内存态，多实例强度 ÷N。
     */
    private static final ConcurrentHashMap<String, long[]> LAST_CHANNEL_QUERY = new ConcurrentHashMap<>();

    /** 条目只在节流窗口内有意义，超界即清理，防长期运行慢泄漏。 */
    private static final int CHANNEL_QUERY_MAX_ENTRIES = 4096;

    /** 同 uid 上次成功建单时间（冷却检查用；整体清空，不做请求线程 O(n) 扫描）。 */
    private static final ConcurrentHashMap<Long, Long> LAST_CREATE_BY_UID = new ConcurrentHashMap<>();

    /** 用户面渠道出网并发上限：Tomcat 200 线程共享，渠道 5s 超时下防止线程与渠道配额被单个接口打满。 */
    private static final int CHANNEL_PERMITS = 32;
    private static final long CHANNEL_ACQUIRE_TIMEOUT_MS = 2_000L;

    /** precreate 结果缓存：同一订单号在渠道侧幂等，5 分钟内刷新二维码无需重复出网。 */
    private static final long PAY_PARAMS_TTL_MS = 5 * 60_000L;
    private static final int PAY_PARAMS_MAX_ENTRIES = 4096;

    /** 全局下单闸门的固定窗口状态（单实例内有效；多实例各自计数，见 docs/app-pay.md）。 */
    private final AtomicInteger gateCount = new AtomicInteger();
    private volatile long gateWindowStart;
    private final Object gateLock = new Object();

    /** 渠道出网许可（用户面：建单/取二维码/读单实时查单）。 */
    private final Semaphore channelPermits = new Semaphore(CHANNEL_PERMITS);

    /** orderNo -> precreate 参数（短 TTL，仅非 MOCK 渠道）。 */
    private final ConcurrentHashMap<String, CachedPayParams> payParamsCache = new ConcurrentHashMap<>();

    private record CachedPayParams(Map<String, Object> params, long expiresAt) {
    }

    /** 退避基值与封顶：3s→6s→12s→24s。 */
    private static final long THROTTLE_BASE_MS = 3000L;
    private static final long THROTTLE_CAP_MS = 24000L;

    /** Creation result: order + frontend payment params (MOCK = confirm endpoint; ALIPAY = scan qrCode). */
    public record CreatedOrder(PayOrder order, Map<String, Object> payParams) {
    }

    public CreatedOrder createOrder(long uid, String skuCode, PayOrder.PayChannel channel,
                                    String idempotencyKey) {
        // 全局下单闸门：Sybil 洪水第一道闸，不开事务直接拒绝
        enforceGlobalOrderGate();
        // Channel availability is checked first: **all channels go through the router** (including MOCK).
        // Previously a special case skipped the adapter for MOCK, so production (mock.enabled=false) could still
        // create orders that could never be paid.
        PayChannelAdapter adapter = channelRouter.requireAdapter(channel);

        // 渠道出网并发闸门：许可覆盖“事务 + precreate”，避免渠道慢/被刷时 Tomcat 线程被同步 HTTP 吃满
        acquireChannelPermit();
        try {
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
            Map<String, Object> payParams = adapter.createPayment(order);
            cachePayParams(order, payParams);
            return new CreatedOrder(order, payParams);
        } finally {
            channelPermits.release();
        }
    }

    /** Transaction core: idempotency check + atomic open-order slot + product snapshot insert + post-commit timeout registration. */
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

        // 与档位锁无关的限额先查：缩短下面 FOR UPDATE 的持锁窗口
        enforcePaidVelocityLimit(uid, now);

        // 档位墙 + 升级换购：
        //   FREE → 任意档可买；
        //   productRank > currentRank → 跨档升级，全价购买（交付顺延，原剩余时长保留）；
        //   productRank == currentRank → 同档「补差价升级」：基于会员 last_order_no 的
        //     DELIVERED 订单，且新 SKU 时长/价格严格更高：金额 = 新 SKU 价 − 旧单价，
        //     交付天数 = 新 SKU 天数 − 旧单天数（交付顺延 → 总时长 = 原购买日起的新套餐全长，
        //     已用天数不浪费）；
        //   productRank < currentRank → 降档，拒绝。
        // FOR UPDATE 锁窗口 = 档位判定 + 升级解析 + 冷却 O(1) + insert。
        PayMembership locked = membershipService.lockActiveMembershipForUpdate(uid);
        boolean memberActive = locked != null && membershipService.isActive(locked);
        int currentRank = memberActive ? MembershipService.tierRank(locked.getTier()) : 0;
        int productRank = MembershipService.tierRank(product.getTier());

        long amountCents = product.getPriceCents();
        int durationDays = product.getDurationDays();
        PayOrder upgradeFrom = null;

        if (memberActive && productRank < currentRank) {
            String currentTier = tierName(currentRank);
            audit.audit("PURCHASE_TIER_BLOCKED", "uid", uid, "current", currentTier,
                    "sku", product.getCode(), "product_tier", product.getTier());
            log.info("[PAY] purchase_tier_blocked uid={} current={} sku={} product_tier={}",
                    uid, currentTier, product.getCode(), product.getTier());
            throw ApiException.conflict("TIER_DOWNGRADE_BLOCKED",
                    "当前 " + currentTier + " 会员有效期内不可购买更低档位，仅支持向上升级更高档位");
        }
        if (memberActive && productRank == currentRank) {
            upgradeFrom = resolveUpgradeBase(locked, product);
            amountCents = product.getPriceCents() - upgradeFrom.getAmountCents();
            durationDays = product.getDurationDays() - upgradeFrom.getDurationDays();
        } else if (memberActive && productRank > currentRank) {
            // 跨档升级不能按短周期 SKU 全价叠加：那会把剩余 VIP 年卡整体变成
            // SVIP。这里只把「剩余时长」升档，按日均价差补钱，不延长到期日。
            CrossTierUpgrade up = resolveCrossTierUpgrade(locked, product, now);
            upgradeFrom = up.base();
            amountCents = up.amountCents();
            durationDays = up.durationDays();
        }

        // 同 uid 建单冷却：排在档位墙之后 —— 重复购买的老用户应看到明确的
        // TIER_DOWNGRADE_BLOCKED 文案，而不是模糊的冷却提示；幂等重试不经过此检查
        enforceOrderCooldown(uid);

        // 升级单单一在途约束：多张基于同一基准的差价单都被支付会重复顺延时长，
        // 第二张起应以交付后的新基准重新计价
        if (upgradeFrom != null) {
            enforceSinglePendingUpgrade(uid);
        }

        PayOrder order = new PayOrder();
        order.setOrderNo(generateOrderNo());
        order.setUid(uid);
        order.setSkuCode(product.getCode());
        order.setProductTitle(product.getTitle());
        order.setDurationDays(durationDays);
        order.setAmountCents(amountCents);
        order.setTier(product.getTier());
        if (upgradeFrom != null) {
            order.setUpgradeFromOrderNo(upgradeFrom.getOrderNo());
        }
        order.setChannel(channel);
        order.setExpiresAt(productService.expireAtFrom(now));
        order.setIdempotencyKey(idempotencyKey == null || idempotencyKey.isBlank() ? null : idempotencyKey.trim());
        order.setCreatedAt(now);
        // 未支付订单上限：数据库唯一槽位原子占位（并发无法绕过）
        insertOrderWithOpenSlot(order);

        // Register the timeout delegation with app-task (runs after commit; failures only warn and fallback polling takes over, plan/1.0.8)
        timerClient.registerOrderTimeoutAfterCommit(uid, order.getOrderNo(),
                order.getVersion(), order.getExpiresAt());

        metrics.orderCreated();
        LAST_CREATE_BY_UID.put(uid, clock.millis());
        log.info("[PAY] order_created uid={} sku={} amount_cents={} expires_at={} open_slot={}",
                uid, order.getSkuCode(), order.getAmountCents(), order.getExpiresAt(), order.getOpenSlot());
        audit.audit("ORDER_CREATED", "uid", uid, "order_no", order.getOrderNo(),
                "sku", order.getSkuCode(), "amount_cents", order.getAmountCents(),
                "channel", channel.name(),
                "upgrade_from", order.getUpgradeFromOrderNo(),
                "discount_cents", upgradeFrom != null
                        ? product.getPriceCents() - amountCents : 0);
        return order;
    }

    /**
     * 用 (uid, open_slot) 唯一索引原子占用一个未支付订单槽位（1..maxOpenPerUser）。
     * 任一槽位插入成功即返回；全部冲突 = 该用户未支付订单已达上限 → 429。
     * 非槽位冲突（订单号/幂等键唯一键）原样抛出，交给外层 recoverAfterDuplicateKey。
     */
    private void insertOrderWithOpenSlot(PayOrder order) {
        int max = payProperties.order() == null ? 0 : payProperties.order().maxOpenPerUser();
        if (max <= 0) {
            orderMapper.insert(order);
            return;
        }
        for (int slot = 1; slot <= max; slot++) {
            order.setId(null);
            order.setOpenSlot(slot);
            try {
                orderMapper.insert(order);
                return;
            } catch (DuplicateKeyException e) {
                if (!isOpenSlotConflict(e)) {
                    throw e;
                }
                // 该槽位被同 uid 的另一张未支付订单占用：尝试下一个槽位
            }
        }
        log.warn("[PAY] open_order_limit_hit uid={} max={}", order.getUid(), max);
        throw ApiException.tooManyRequests("TOO_MANY_OPEN_ORDERS",
                "Too many unpaid orders, please pay or cancel before creating a new one");
    }

    private static boolean isOpenSlotConflict(DuplicateKeyException e) {
        String message = String.valueOf(e.getMessage());
        return message.contains("uk_pay_order_uid_slot");
    }

    private static String tierName(int rank) {
        return switch (rank) {
            case 3 -> "PROMAX";
            case 2 -> "SVIP";
            case 1 -> "VIP";
            default -> "FREE";
        };
    }

    /** 跨档升级结果：基准单、补差金额、需要顺延的天数（0 = 仅换档，不延长）。 */
    private record CrossTierUpgrade(PayOrder base, long amountCents, int durationDays) {
    }

    /**
     * 跨档升级（VIP → SVIP/ProMax）：只升级「剩余时长」，按
     * 剩余天数 × (目标档位日均价 − 当前档位日均价) 补差；到期日不变（交付天数 0）。
     *
     * <p>不能直接按短周期 SKU 全价交付：PayMembership 只有单一 tier/expireAt，
     * extendLocked 会把剩余 VIP 时长整体改成新 tier。因此必须把剩余时长纳入计价，
     * 且禁止目标周期短于剩余时长（例如 VIP 年卡剩余 365 天不能买 SVIP 月卡）。
     */
    private CrossTierUpgrade resolveCrossTierUpgrade(PayMembership locked, PayProduct product, LocalDateTime now) {
        if (locked.getLastOrderNo() == null || locked.getLastOrderNo().isBlank()) {
            throw ApiException.conflict("UPGRADE_BASE_INVALID",
                    "当前会员无可用升级基准（赠送/人工开通的会员请联系客服处理）");
        }
        PayOrder old = selectByOrderNo(locked.getLastOrderNo());
        if (old == null || old.getStatus() != PayOrder.OrderStatus.DELIVERED
                || old.getDurationDays() <= 0 || old.getAmountCents() <= 0) {
            throw ApiException.conflict("UPGRADE_BASE_INVALID",
                    "升级基准订单无效，请联系客服处理");
        }
        long remainingDays = remainingDays(locked.getExpireAt(), now);
        if (remainingDays <= 0) {
            throw ApiException.conflict("UPGRADE_BASE_INVALID", "当前会员已过期，请重新购买");
        }
        if (product.getDurationDays() < remainingDays) {
            throw ApiException.conflict("UPGRADE_TARGET_TOO_SHORT",
                    "当前会员剩余 " + remainingDays + " 天，目标套餐仅 " + product.getDurationDays()
                            + " 天；请选择不短于剩余时长的套餐");
        }
        // 只升级「剩余时长」：按目标档位日均价 − 当前档位日均价补差，
        // 不再延长到期日（否则用户要为已用掉的旧套餐天数重复付费）。
        double currentDaily = (double) old.getAmountCents() / old.getDurationDays();
        double targetDaily = (double) product.getPriceCents() / product.getDurationDays();
        long amountCents = Math.max(0, Math.round(remainingDays * (targetDaily - currentDaily)));
        if (amountCents <= 0) {
            throw ApiException.conflict("UPGRADE_NO_DIFFERENCE",
                    "目标套餐价格不高于当前剩余权益，无法生成补差价订单");
        }
        return new CrossTierUpgrade(old, amountCents, 0);
    }

    private static long remainingDays(LocalDateTime expireAt, LocalDateTime now) {
        long millis = Duration.between(now, expireAt).toMillis();
        if (millis <= 0) {
            return 0;
        }
        return (long) Math.ceil(millis / 86_400_000.0);
    }

    /**
     * 升级换购基准单解析：会员必须由一张 DELIVERED 订单交付（last_order_no），
     * 且新 SKU 时长/价格严格更高；否则 409。基准单的剩余时长通过差价补偿，
     * 交付后 last_order_no 自动切换为升级单，支持连续升级（每次按新基准计价）。
     */
    private PayOrder resolveUpgradeBase(PayMembership locked, PayProduct product) {
        if (locked.getLastOrderNo() == null || locked.getLastOrderNo().isBlank()) {
            throw ApiException.conflict("UPGRADE_BASE_INVALID",
                    "当前会员无可用升级基准（赠送/人工开通的会员请联系客服处理）");
        }
        PayOrder old = selectByOrderNo(locked.getLastOrderNo());
        if (old == null || old.getStatus() != PayOrder.OrderStatus.DELIVERED
                || old.getDurationDays() <= 0 || old.getAmountCents() <= 0) {
            throw ApiException.conflict("UPGRADE_BASE_INVALID",
                    "升级基准订单无效，请联系客服处理");
        }
        if (product.getDurationDays() <= old.getDurationDays()
                || product.getPriceCents() <= old.getAmountCents()) {
            throw ApiException.conflict("UPGRADE_NO_DIFFERENCE",
                    "当前剩余时长已覆盖目标套餐，请到期后再续费");
        }
        return old;
    }

    /** 同一会话仅允许一张待支付升级单：防止基于同一基准的多张差价单重复顺延时长。 */
    private void enforceSinglePendingUpgrade(long uid) {
        Long pending = orderMapper.selectCount(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                .isNotNull(PayOrder::getUpgradeFromOrderNo));
        if (pending != null && pending > 0) {
            throw ApiException.conflict("UPGRADE_ORDER_PENDING",
                    "已有一张待支付的升级订单，请先支付或取消");
        }
    }

    /**
     * 升级换购报价：当前有效会员可补差价升级的同档 SKU 列表（商品卡展示差价用，
     * 建单时服务端按同一公式计价，前端零信任）。
     */
    public List<UpgradeQuote> quoteUpgrades(long uid) {
        PayMembership m = membershipService.findByUid(uid).orElse(null);
        if (m == null || !membershipService.isActive(m)
                || m.getLastOrderNo() == null || m.getLastOrderNo().isBlank()) {
            return List.of();
        }
        PayOrder old = selectByOrderNo(m.getLastOrderNo());
        if (old == null || old.getStatus() != PayOrder.OrderStatus.DELIVERED) {
            return List.of();
        }
        int currentRank = MembershipService.tierRank(m.getTier());
        LocalDateTime now = LocalDateTime.now(clock);
        List<UpgradeQuote> quotes = new ArrayList<>();
        for (PayProduct p : productService.listActive()) {
            int productRank = MembershipService.tierRank(p.getTier());
            if (productRank < currentRank) {
                continue; // 降档不报
            }
            if (productRank == currentRank) {
                // 同档：时长/价格严格更高的 SKU 才可补差价
                if (p.getDurationDays() <= old.getDurationDays()
                        || p.getPriceCents() <= old.getAmountCents()) {
                    continue;
                }
                int days = p.getDurationDays() - old.getDurationDays();
                quotes.add(new UpgradeQuote(p.getCode(), p.getTitle(), p.getTier(), days,
                        p.getPriceCents() - old.getAmountCents(), old.getAmountCents(),
                        p.getPriceCents(),
                        m.getExpireAt().plusDays(days).toLocalDate().toString()));
                continue;
            }
            // 跨档：按剩余时长折算抵扣；目标周期短于剩余时长的 SKU 不报价
            try {
                CrossTierUpgrade up = resolveCrossTierUpgrade(m, p, now);
                int days = up.durationDays();
                quotes.add(new UpgradeQuote(p.getCode(), p.getTitle(), p.getTier(), days,
                        up.amountCents(), old.getAmountCents(), p.getPriceCents(),
                        m.getExpireAt().plusDays(days).toLocalDate().toString()));
            } catch (ApiException ignored) {
                // 当前剩余时长覆盖不了该 SKU / 无差价：该商品卡保持不可选
            }
        }
        return quotes;
    }

    /**
     * 全局下单闸门：单实例每分钟建单上限的固定窗口计数。Sybil 洪水（大量账号 × 10 单/uid）
     * 的第一道闸 —— 不开事务直接拒绝，攻击者烧不到渠道配额。多实例各自计数（强度 = limit × N），
     * 集中化需引入 Redis，评估结论见 docs/app-pay.md。0 = 关闭。
     */
    private void enforceGlobalOrderGate() {
        PayProperties.Risk risk = payProperties.risk();
        int max = risk == null ? 0 : risk.globalOrdersPerMinute();
        if (max <= 0) {
            return;
        }
        long nowMs = clock.millis();
        synchronized (gateLock) {
            if (nowMs - gateWindowStart >= 60_000L) {
                gateWindowStart = nowMs;
                gateCount.set(0);
            }
            if (gateCount.incrementAndGet() > max) {
                metrics.riskBlocked("global");
                audit.audit("RISK_GLOBAL_GATE_EXCEEDED", "window_count", gateCount.get(), "max", max);
                log.warn("[PAY] risk_global_gate_exceeded count={} max={}", gateCount.get(), max);
                throw ApiException.tooManyRequests("RISK_GLOBAL_GATE_EXCEEDED",
                        "Order creation rate limit reached, please try again later");
            }
        }
    }

    /** 同 uid 建单冷却：两次成功建单的最小间隔；幂等重试不经过此检查。 */
    private void enforceOrderCooldown(long uid) {
        PayProperties.Risk risk = payProperties.risk();
        int cooldown = risk == null ? 0 : risk.orderCooldownSeconds();
        if (cooldown <= 0) {
            return;
        }
        long nowMs = clock.millis();
        Long last = LAST_CREATE_BY_UID.get(uid);
        if (last != null && nowMs - last < cooldown * 1000L) {
            metrics.riskBlocked("cooldown");
            audit.audit("RISK_COOLDOWN_BLOCKED", "uid", uid,
                    "since_last_ms", nowMs - last, "cooldown_seconds", cooldown);
            log.warn("[PAY] risk_cooldown_blocked uid={} since_last_ms={}", uid, nowMs - last);
            throw ApiException.tooManyRequests("ORDER_COOLDOWN",
                    "Please wait " + cooldown + "s between order attempts");
        }
        // 有界清理：超过阈值直接整体清空（冷却豁免一次可接受），避免在请求线程做 O(n) 扫描
        if (LAST_CREATE_BY_UID.size() > 100_000) {
            LAST_CREATE_BY_UID.clear();
        }
    }

    /**
     * 支付频次风控：单 uid 滚动 24h 的成功支付笔数/金额上限，在下单时拦截 ——
     * 防盗刷与异常购买速度（重复购买拦截只看档位，不看频次）。0 = 不限该维度。
     */
    private void enforcePaidVelocityLimit(long uid, LocalDateTime now) {
        PayProperties.Risk risk = payProperties.risk();
        if (risk == null) {
            return;
        }
        int maxOrders = risk.maxPaidOrdersPerDay();
        long maxAmount = risk.maxPaidAmountPerDayCents();
        if (maxOrders <= 0 && maxAmount <= 0) {
            return;
        }
        PaidOrderSummary summary = orderMapper.sumPaidSince(uid, now.minusHours(24));
        if (summary == null) {
            return;
        }
        if ((maxOrders > 0 && summary.getCnt() >= maxOrders)
                || (maxAmount > 0 && summary.getTotal() >= maxAmount)) {
            metrics.riskBlocked("velocity");
            audit.audit("RISK_VELOCITY_BLOCKED", "uid", uid,
                    "paid_orders_24h", summary.getCnt(), "paid_amount_24h_cents", summary.getTotal(),
                    "max_orders", maxOrders, "max_amount_cents", maxAmount);
            log.warn("[PAY] risk_velocity_blocked uid={} orders_24h={} amount_24h_cents={}",
                    uid, summary.getCnt(), summary.getTotal());
            throw ApiException.tooManyRequests("RISK_VELOCITY_EXCEEDED",
                    "Payment velocity limit reached for this account, please try again later");
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
     * 结果按订单短缓存 5 分钟：二维码刷新不再放大渠道调用（渠道配额保护）。
     */
    public Map<String, Object> paymentParams(PayOrder order) {
        if (order.getChannel() == PayOrder.PayChannel.MOCK) {
            return channelRouter.requireAdapter(order.getChannel()).createPayment(order);
        }
        String key = order.getOrderNo();
        long now = clock.millis();
        CachedPayParams cached = payParamsCache.get(key);
        if (cached != null && cached.expiresAt() > now) {
            return cached.params();
        }
        acquireChannelPermit();
        try {
            Map<String, Object> params = channelRouter.requireAdapter(order.getChannel())
                    .createPayment(order);
            cachePayParams(order, params);
            return params;
        } finally {
            channelPermits.release();
        }
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
        long now = clock.millis();
        long[] state = LAST_CHANNEL_QUERY.computeIfAbsent(orderNo, k -> new long[]{0, 0});
        synchronized (state) {
            // 退避：第 n+1 次查询需距上次 ≥ min(3000×2^n, 24000)ms
            long delay = Math.min(THROTTLE_BASE_MS << Math.min((int) state[1], 3), THROTTLE_CAP_MS);
            if (now - state[0] < delay) {
                return order;
            }
            state[0] = now;
            state[1]++;
        }
        // 内存上界：ConcurrentHashMap 无自动过期，长期运行下残留会堆积；
        // 超阈值先清理 2×封顶窗口无活动的条目再继续（弱一致 removeIf，O(n) 仅偶发触发）
        if (LAST_CHANNEL_QUERY.size() >= CHANNEL_QUERY_MAX_ENTRIES) {
            LAST_CHANNEL_QUERY.entrySet().removeIf(e -> now - e.getValue()[0] >= THROTTLE_CAP_MS * 2);
        }
        try {
            PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
            ChannelQueryResult result = withChannelPermit(() -> adapter.queryOrder(order));
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
        return listOwnedOrders(uid, limit, 0);
    }

    /** Paginated slice; orderNo is the stable tie-breaker for equal createdAt values. */
    public List<PayOrder> listOwnedOrders(long uid, int limit, int offset) {
        return orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .orderByDesc(PayOrder::getCreatedAt)
                .orderByDesc(PayOrder::getOrderNo)
                .last("LIMIT " + Math.max(1, limit) + " OFFSET " + Math.max(0, offset)));
    }

    /** Total orders for the pager (same uid predicate as listOwnedOrders). */
    public long countOwnedOrders(long uid) {
        return orderMapper.selectCount(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid));
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

    /** 缓存 precreate 结果（同一订单号渠道侧幂等）；有界 + 过期清理，防长期运行慢泄漏。 */
    private void cachePayParams(PayOrder order, Map<String, Object> params) {
        if (params == null || order.getChannel() == PayOrder.PayChannel.MOCK) {
            return;
        }
        long now = clock.millis();
        if (payParamsCache.size() >= PAY_PARAMS_MAX_ENTRIES) {
            payParamsCache.entrySet().removeIf(e -> e.getValue().expiresAt() <= now);
            if (payParamsCache.size() >= PAY_PARAMS_MAX_ENTRIES) {
                payParamsCache.clear();
            }
        }
        payParamsCache.put(order.getOrderNo(), new CachedPayParams(params, now + PAY_PARAMS_TTL_MS));
    }

    /** 渠道出网并发许可：拿不到直接 429 快速失败（不排队占线程）。 */
    private void acquireChannelPermit() {
        boolean acquired;
        try {
            acquired = channelPermits.tryAcquire(CHANNEL_ACQUIRE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApiException.serviceUnavailable("CHANNEL_BUSY", "Payment channel is busy, please retry later");
        }
        if (!acquired) {
            metrics.channelThrottled();
            log.warn("[PAY] channel_permit_rejected -- channel concurrency saturated");
            throw ApiException.tooManyRequests("CHANNEL_BUSY", "Payment channel is busy, please retry later");
        }
    }

    private <T> T withChannelPermit(Supplier<T> call) {
        acquireChannelPermit();
        try {
            return call.get();
        } finally {
            channelPermits.release();
        }
    }
}
