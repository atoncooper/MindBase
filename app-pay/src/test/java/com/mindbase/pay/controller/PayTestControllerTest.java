package com.mindbase.pay.controller;

import com.mindbase.pay.common.GlobalExceptionHandler;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.ProductService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 测试入口的三重闸门：开关关闭 404 隐身、令牌 401、通过后全流程可用。 */
@ExtendWith(MockitoExtension.class)
class PayTestControllerTest {

    @Mock
    private ProductService productService;
    @Mock
    private OrderService orderService;
    @Mock
    private MockChannelService mockChannelService;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;

    private MockMvc enabled;
    private MockMvc disabled;

    @BeforeEach
    void setUp() {
        PayProperties on = props(true, "secret-token");
        enabled = MockMvcBuilders.standaloneSetup(new PayTestController(on,
                        productService, orderService, mockChannelService, membershipService, audit))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
        PayProperties off = props(false, "secret-token");
        disabled = MockMvcBuilders.standaloneSetup(new PayTestController(off,
                        productService, orderService, mockChannelService, membershipService, audit))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    private PayProperties props(boolean enabledFlag, String token) {
        return new PayProperties(null, null, null, null,
                new PayProperties.Test(enabledFlag, token), null, null);
    }

    @Test
    void disabledReturns404Invisible() throws Exception {
        disabled.perform(get("/test/pay/products").header("X-Test-Token", "secret-token"))
                .andExpect(status().isNotFound());
    }

    @Test
    void wrongOrMissingTokenReturns401() throws Exception {
        enabled.perform(get("/test/pay/products").header("X-Test-Token", "wrong"))
                .andExpect(status().isUnauthorized());
        enabled.perform(get("/test/pay/products"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void queryTokenAcceptedForConsoleImg() throws Exception {
        enabled.perform(get("/test/pay/qr").param("token", "secret-token").param("text", "hello"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"));
    }

    @Test
    void createOrderThenMockPayFullFlow() throws Exception {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setAmountCents(1800L);
        order.setChannel(PayOrder.PayChannel.MOCK);
        order.setStatus(PayOrder.OrderStatus.CREATED);
        when(orderService.createOrder(eq(10086L), eq("VIP_MONTHLY"),
                eq(PayOrder.PayChannel.MOCK), eq(null)))
                .thenReturn(new OrderService.CreatedOrder(order, Map.of("type", "mock")));

        enabled.perform(post("/test/pay/orders").header("X-Test-Token", "secret-token")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"uid\":10086,\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.orderNo").value("PO1"))
                .andExpect(jsonPath("$.payParams.type").value("mock"));

        PayOrder delivered = new PayOrder();
        delivered.setOrderNo("PO1");
        delivered.setUid(10086L);
        delivered.setAmountCents(1800L);
        delivered.setChannel(PayOrder.PayChannel.MOCK);
        delivered.setStatus(PayOrder.OrderStatus.DELIVERED);
        when(mockChannelService.confirmPaid(10086L, "PO1")).thenReturn(delivered);

        enabled.perform(post("/test/pay/mock-pay").header("X-Test-Token", "secret-token")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"uid\":10086,\"orderNo\":\"PO1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("DELIVERED"));
        verify(audit).audit(eq("TEST_MOCK_PAY"), eq("uid"), eq(10086L),
                eq("order_no"), eq("PO1"));
    }

    @Test
    void oversizedSkuRejectedAtValidationLayer() throws Exception {
        // @Size(max=50)：超长输入在 400 校验层拒绝，而非穿透到 DB 变 500
        enabled.perform(post("/test/pay/orders").header("X-Test-Token", "secret-token")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"uid\":10086,\"skuCode\":\"" + "X".repeat(60)
                                + "\",\"channel\":\"MOCK\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    @Test
    void blankTokenMeansDefaultPass() throws Exception {
        // 未配置令牌 = 默认验证通过（本机回环 + 开关即闸门）
        PayProperties open = props(true, "");
        MockMvc openMvc = MockMvcBuilders.standaloneSetup(new PayTestController(open,
                        productService, orderService, mockChannelService, membershipService, audit))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
        when(productService.listActive()).thenReturn(java.util.List.of());

        openMvc.perform(get("/test/pay/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
    }

    @Test
    void burstCreateOrdersRunsConcurrently() throws Exception {
        when(orderService.createOrder(eq(10086L), eq("VIP_MONTHLY"),
                eq(PayOrder.PayChannel.MOCK), eq(null)))
                .thenAnswer(inv -> {
                    PayOrder o = new PayOrder();
                    o.setOrderNo("PO" + System.nanoTime());
                    o.setUid(10086L);
                    o.setAmountCents(1800L);
                    o.setChannel(PayOrder.PayChannel.MOCK);
                    o.setStatus(PayOrder.OrderStatus.CREATED);
                    return new OrderService.CreatedOrder(o, Map.of("type", "mock"));
                });

        enabled.perform(post("/test/pay/burst").header("X-Test-Token", "secret-token")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"mode\":\"CREATE_ORDERS\",\"count\":3,\"uid\":10086,\"skuCode\":\"VIP_MONTHLY\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(3))
                .andExpect(jsonPath("$.stats.CREATE").value(3));
        verify(orderService, times(3)).createOrder(anyLong(), anyString(),
                any(PayOrder.PayChannel.class), any());
    }

    @Test
    void burstPaySameRequiresOrderNo() throws Exception {
        enabled.perform(post("/test/pay/burst").header("X-Test-Token", "secret-token")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"mode\":\"PAY_SAME\",\"count\":3,\"uid\":10086}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("ORDER_NO_REQUIRED"));
    }

    @Test
    void membershipOfStrangerIsInactive() throws Exception {
        when(membershipService.findByUid(10086L)).thenReturn(java.util.Optional.empty());

        enabled.perform(get("/test/pay/membership/10086").header("X-Test-Token", "secret-token"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));
    }
}
