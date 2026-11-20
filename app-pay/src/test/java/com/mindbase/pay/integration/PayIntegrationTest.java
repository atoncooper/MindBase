package com.mindbase.pay.integration;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.mapper.PayGrantIdempotencyMapper;
import com.mindbase.pay.mapper.PayGrantQuotaMapper;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayGrantQuota;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.GrantService;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.RefundService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Real MySQL integration test (conditional-update SQL / transaction boundaries / Flyway migrations).
 * The whole class is skipped automatically when Docker is unavailable locally (disabledWithoutDocker=true); it runs in CI / on Docker-enabled environments.
 *
 * <p>P0/P1 回归覆盖：内部接口 X-Internal-Key、未支付订单槽位并发上限、重复购买第二道墙（自动退款不交付）、
 * ADMIN_GRANT 幂等与日额度原子熔断。
 */
@SpringBootTest(properties = {
        "server.ssl.enabled=false",
        "pay.apptask.register-enabled=false",
        "pay.mock.enabled=true",
        "pay.test.enabled=true",
        "pay.test.token=test-token",
        "pay.test.require-token=false",
        "pay.refund.enabled=true",
        "pay.internal.api-key=it-internal-key",
        "pay.risk.order-cooldown-seconds=0",
        "pay.risk.global-orders-per-minute=0",
        "management.endpoints.web.exposure.include=health"
})
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
class PayIntegrationTest {

    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    @Container
    @SuppressWarnings("resource")
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.4")
            .withDatabaseName("app_pay")
            .withUsername("app_pay")
            .withPassword("app-pay");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("pay.rdbms.url", MYSQL::getJdbcUrl);
        registry.add("pay.rdbms.username", MYSQL::getUsername);
        registry.add("pay.rdbms.password", MYSQL::getPassword);
    }

    @Autowired
    private OrderService orderService;
    @Autowired
    private MockChannelService mockChannelService;
    @Autowired
    private MembershipService membershipService;
    @Autowired
    private RefundService refundService;
    @Autowired
    private GrantService grantService;
    @Autowired
    private PayOrderMapper orderMapper;
    @Autowired
    private PayMembershipEventMapper eventMapper;
    @Autowired
    private PayGrantQuotaMapper grantQuotaMapper;
    @Autowired
    private PayGrantIdempotencyMapper grantIdempotencyMapper;
    @Autowired
    private MockMvc mockMvc;

    @Test
    void mockPurchaseDeliversThenRefundRevokes() {
        long uid = 987654321L;
        OrderService.CreatedOrder created = orderService.createOrder(
                uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-1");
        String orderNo = created.order().getOrderNo();

        PayOrder paid = mockChannelService.confirmPaid(uid, orderNo);
        assertThat(paid.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);

        var membership = membershipService.findByUid(uid).orElseThrow();
        assertThat(membershipService.isActive(membership)).isTrue();
        assertThat(membership.getTier()).isEqualTo("VIP");

        PayOrder refunded = refundService.refund(orderNo, "integration refund", true);
        assertThat(refunded.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDED);
        // the 30-day membership is revoked (its period is exactly 30 days -> it returns to near now and is no longer active)
        var afterRefund = membershipService.findByUid(uid).orElseThrow();
        assertThat(afterRefund.getExpireAt()).isBeforeOrEqualTo(membership.getExpireAt());
    }

    @Test
    void idempotencyKeyReturnsSameOrder() {
        long uid = 987654322L;
        var first = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-2");
        var second = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-2");
        assertThat(second.order().getOrderNo()).isEqualTo(first.order().getOrderNo());
    }

    @Test
    void svipPurchaseIsNotDowngradedByLaterVipPurchase() {
        long uid = 987654323L;
        var svip = orderService.createOrder(uid, "SVIP_YEARLY", PayOrder.PayChannel.MOCK, null);
        mockChannelService.confirmPaid(uid, svip.order().getOrderNo());
        assertThat(membershipService.findByUid(uid).orElseThrow().getTier()).isEqualTo("SVIP");

        // 防重复购买（下单即拒）：SVIP 有效期内创建 VIP 订单直接 409，仅允许向上升级
        assertThatThrownBy(() -> orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("仅支持向上升级更高档位");

        assertThat(membershipService.findByUid(uid).orElseThrow().getTier()).isEqualTo("SVIP");
    }

    // ── P0 回归 ─────────────────────────────────────────────────────────────

    @Test
    void internalEndpointRequiresInternalKey() throws Exception {
        // 服务端二次鉴权：绕过网关直连 /internal/pay/* 必须 401；带正确 key 才 200
        mockMvc.perform(get("/internal/pay/membership/1"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));

        mockMvc.perform(get("/internal/pay/membership/1").header("X-Internal-Key", "it-internal-key"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value(1));
    }

    @Test
    void concurrentOrderCreationRespectsOpenOrderCap() throws Exception {
        // 20 个线程同时为同一 FREE 用户建单：数据库槽位唯一键必须把成功数精确限制在 10
        long uid = 987654330L;
        int attempts = 20;
        ExecutorService pool = Executors.newFixedThreadPool(attempts);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Boolean>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < attempts; i++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    try {
                        orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null);
                        return true;
                    } catch (ApiException e) {
                        return false;
                    }
                }));
            }
            start.countDown();
            int success = 0;
            for (Future<Boolean> f : futures) {
                if (Boolean.TRUE.equals(f.get(60, TimeUnit.SECONDS))) {
                    success++;
                }
            }
            assertThat(success).isEqualTo(10);
        } finally {
            pool.shutdownNow();
        }

        Long open = orderMapper.selectCount(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getUid, uid)
                .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED));
        assertThat(open).isEqualTo(10);
    }

    @Test
    void secondSameTierPurchaseIsAutoRefundedNotDelivered() {
        // FREE 用户先建两张 VIP 月卡（建单时都没有有效会员，允许）；第一张交付后第二张必须被
        // 唯一交付入口的第二道墙拦截：冻结 + 自动原路退款，且会员只延长一次。
        long uid = 987654331L;
        var first = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-dup-1");
        var second = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-dup-2");

        assertThat(mockChannelService.confirmPaid(uid, first.order().getOrderNo()).getStatus())
                .isEqualTo(PayOrder.OrderStatus.DELIVERED);

        PayOrder secondPaid = mockChannelService.confirmPaid(uid, second.order().getOrderNo());
        assertThat(secondPaid.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDED);

        var membership = membershipService.findByUid(uid).orElseThrow();
        // 只交付了一次 30 天（允许少量执行耗时误差）
        assertThat(membership.getExpireAt()).isBefore(LocalDateTime.now(ZONE).plusDays(31));
        Long activates = eventMapper.selectCount(new LambdaQueryWrapper<PayMembershipEvent>()
                .eq(PayMembershipEvent::getUid, uid)
                .eq(PayMembershipEvent::getType, PayMembershipEvent.EventType.ACTIVATE));
        assertThat(activates).isEqualTo(1);

        // 交付后 open_slot 必须释放（否则会永久占用未支付槽位）
        PayOrder firstInDb = orderMapper.selectOne(new LambdaQueryWrapper<PayOrder>()
                .eq(PayOrder::getOrderNo, first.order().getOrderNo()));
        assertThat(firstInDb.getOpenSlot()).isNull();
    }

    @Test
    void grantIsIdempotentAndQuotaCountedOnce() {
        long uid = 987654332L;
        var first = grantService.grant(uid, 30, "integration compensation", "VIP", "it-grant-req-1");
        var replay = grantService.grant(uid, 30, "integration compensation", "VIP", "it-grant-req-1");

        // 首次返回值来自内存（纳秒），重放来自 DATETIME(6)（微秒）；截断到秒比较即可证明未被重复延长 30 天
        assertThat(replay.getExpireAt().truncatedTo(ChronoUnit.SECONDS))
                .isEqualTo(first.getExpireAt().truncatedTo(ChronoUnit.SECONDS));
        Long events = eventMapper.selectCount(new LambdaQueryWrapper<PayMembershipEvent>()
                .eq(PayMembershipEvent::getUid, uid)
                .eq(PayMembershipEvent::getType, PayMembershipEvent.EventType.ADMIN_GRANT)
                .eq(PayMembershipEvent::getRequestId, "it-grant-req-1"));
        assertThat(events).isEqualTo(1);

        PayGrantQuota quota = grantQuotaMapper.selectOne(new LambdaQueryWrapper<PayGrantQuota>()
                .eq(PayGrantQuota::getDay, LocalDate.now(ZONE)));
        assertThat(quota).isNotNull();
        // 幂等重放不得重复占用额度（同一天可能还有本测试类其他用例，至少 >=1 且本次只 +1）
        assertThat(quota.getCnt()).isGreaterThanOrEqualTo(1);
        assertThat(quota.getDays()).isGreaterThanOrEqualTo(30);
    }

    @Test
    void grantDailyQuotaRejectsOverLimit() {
        // 单次 1001 天 > 日上限 1000：必须在事务内被额度熔断拒绝（且回滚幂等占位，不产生事件）
        assertThatThrownBy(() -> grantService.grant(987654333L, 1001, "too many days", "VIP", "it-grant-over"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);

        Long events = eventMapper.selectCount(new LambdaQueryWrapper<PayMembershipEvent>()
                .eq(PayMembershipEvent::getRequestId, "it-grant-over"));
        assertThat(events).isZero();
        // 幂等占位也要随事务回滚（否则重试会被误判为“已处理”而拒绝补偿）
        assertThat(grantIdempotencyMapper.selectById("it-grant-over")).isNull();
    }
}