package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.timer.AppTaskTimerClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 下单校验：渠道白名单/适配器委托、SKU 状态、幂等键命中、唯一键兜底、订单号归属。 */
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private ProductService productService;
    @Mock
    private PayChannelRouter channelRouter;
    @Mock
    private PayChannelAdapter alipayAdapter;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private AppTaskTimerClient timerClient;
    @Mock
    private PlatformTransactionManager txManager;

    private OrderService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        // mock 事务管理器：execute 仅回调内核 + commit/rollback 空操作，无事务同步激活
        service = new OrderService(orderMapper, productService, channelRouter, audit,
                timerClient, clock, new TransactionTemplate(txManager));
    }

    private PayProduct product() {
        PayProduct product = new PayProduct();
        product.setCode("VIP_MONTHLY");
        product.setTitle("会员·月度");
        product.setDurationDays(30);
        product.setPriceCents(1800);
        product.setStatus(PayProduct.ProductStatus.ACTIVE);
        return product;
    }

    @Test
    void createOrderSnapshotsProductFields() {
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(NOW)).thenReturn(NOW.plusMinutes(30));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null);
        PayOrder order = outcome.order();

        assertThat(order.getOrderNo()).startsWith("PO");
        assertThat(order.getUid()).isEqualTo(10086L);
        // 快照：后续改价改期不影响此订单
        assertThat(order.getAmountCents()).isEqualTo(1800L);
        assertThat(order.getDurationDays()).isEqualTo(30);
        assertThat(order.getStatus()).isEqualTo(PayOrder.OrderStatus.CREATED);
        assertThat(order.getExpiresAt()).isEqualTo(NOW.plusMinutes(30));
        // mock 渠道返回确认端点参数
        assertThat(outcome.payParams()).containsEntry("type", "mock");
        verify(orderMapper).insert(order);
        // 超时委托注册（测试环境无事务 → afterCommit 同步路径直通）
        verify(timerClient).registerOrderTimeoutAfterCommit(
                eq(10086L), eq(order.getOrderNo()), eq(1), eq(NOW.plusMinutes(30)));
    }

    @Test
    void alipayOrderDelegatesToAdapter() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(NOW)).thenReturn(NOW.plusMinutes(30));
        when(alipayAdapter.createPayment(any(PayOrder.class)))
                .thenReturn(Map.of("type", "alipay_qr", "qrCode", "https://qr.alipay.com/x"));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.ALIPAY, null);

        assertThat(outcome.payParams()).containsEntry("type", "alipay_qr");
        // 渠道取码在事务提交后执行（事务内核只做幂等检查 + 落库）
        verify(alipayAdapter).createPayment(any(PayOrder.class));
        verify(orderMapper).insert(outcome.order());
    }

    @Test
    void disabledChannelRejectedBeforeInsert() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.WECHAT_PAY))
                .thenThrow(ApiException.badRequest("CHANNEL_NOT_SUPPORTED", "Payment channel not supported yet"));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.WECHAT_PAY, null))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("not supported");
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void idempotencyKeyReturnsExistingOrder() {
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-EXIST");
        existing.setUid(10086L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(existing);

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "key-1");

        assertThat(outcome.order().getOrderNo()).isEqualTo("PO-EXIST");
        verify(orderMapper, never()).insert(any(PayOrder.class));
        verify(timerClient, never()).registerOrderTimeoutAfterCommit(
                anyLong(), anyString(), anyInt(), any());
    }

    @Test
    void idempotencyKeyOfAnotherUserConflicts() {
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-EXIST");
        existing.setUid(999L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(existing);

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, "key-1"))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Idempotency key");
    }

    @Test
    void duplicateOrderNoTranslatesToConflict() {
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.insert(any(PayOrder.class)))
                .thenThrow(new DuplicateKeyException("uk_pay_order_no"));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(409);
    }

    @Test
    void concurrentIdempotencyKeyRecoversExistingOrder() {
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-RACE");
        existing.setUid(10086L);
        // 第一次读（幂等检查）未命中 → 落库撞唯一键（并发赢家已提交）→ 兜底重读命中复用
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(null, existing);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.insert(any(PayOrder.class)))
                .thenThrow(new DuplicateKeyException("uk_pay_order_idempotency_key"));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "key-1");

        assertThat(outcome.order().getOrderNo()).isEqualTo("PO-RACE");
        assertThat(outcome.payParams()).containsEntry("type", "mock");
        verify(timerClient, never()).registerOrderTimeoutAfterCommit(
                anyLong(), anyString(), anyInt(), any());
    }

    @Test
    void otherUsersOrderIs404() {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(999L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);

        assertThatThrownBy(() -> service.getOwnedOrder(10086L, "PO1"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(404);
    }
}
