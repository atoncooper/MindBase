package com.mindbase.pay.controller;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.client.j2se.MatrixToImageWriter;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.ProductService;
import com.mindbase.pay.dto.PayDtos;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static com.mindbase.pay.dto.PayDtos.MembershipView;
import static com.mindbase.pay.dto.PayDtos.OrderView;
import static com.mindbase.pay.dto.PayDtos.ProductView;

/**
 * 本机测试入口（/test/pay/*）：M3 前端就绪前在本机跑通支付全流程的入口，
 * 含浏览器控制台 /test/pay/console.html（静态页）。
 *
 * 三重隔离（缺一不可，见 plan/1.0.7-Pay 附录 B）：
 * ① pay.test.enabled 默认 false（关闭时全部 404 隐身）；② 令牌必须匹配；
 * ③ 结构性：APISIX 不路由 /test/*，app-pay 端口仅 127.0.0.1 绑定，公网不可达。
 * 生产/对外环境必须保持 enabled=false。
 */
@Slf4j
@RestController
@RequestMapping("/test/pay")
@RequiredArgsConstructor
public class PayTestController {

    private final PayProperties payProperties;
    private final ProductService productService;
    private final OrderService orderService;
    private final MockChannelService mockChannelService;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;

    @GetMapping("/products")
    public Object products(@RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                           @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        return productService.listActive().stream().map(ProductView::from).toList();
    }

    /** 指定 uid 下单（绕过网关鉴权，仅本机测试）。 */
    @PostMapping("/orders")
    public Object createOrder(@Valid @RequestBody PayDtos.TestCreateOrderRequest req,
                              @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                              @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(req.uid()));
        return orderService.createOrder(req.uid(), req.skuCode(), req.channel(), null);
    }

    /** 模拟支付成功（等价 M1 mock 渠道；用于不扫沙箱二维码时快速走完闭环）。 */
    @PostMapping("/mock-pay")
    public OrderView mockPay(@Valid @RequestBody PayDtos.TestMockPayRequest req,
                             @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                             @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(req.uid()));
        audit.audit("TEST_MOCK_PAY", "uid", req.uid(), "order_no", req.orderNo());
        PayOrder order = mockChannelService.confirmPaid(req.uid(), req.orderNo());
        return OrderView.from(order);
    }

    @GetMapping("/order/{orderNo}")
    public Object order(@PathVariable String orderNo, @RequestParam long uid,
                        @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                        @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(uid));
        return OrderView.from(orderService.getOwnedOrder(uid, orderNo));
    }

    @GetMapping("/membership/{uid}")
    public MembershipView membership(@PathVariable long uid,
                                     @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                                     @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(uid));
        return membershipService.findByUid(uid)
                .map(m -> MembershipView.from(m, membershipService.isActive(m)))
                .orElse(new MembershipView(null, false, null, false));
    }

    /** 我的最近订单（控制台概览）。 */
    @GetMapping("/orders")
    public List<OrderView> orders(@RequestParam long uid,
                                  @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                                  @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(uid));
        return orderService.listRecentByUid(uid, 10).stream().map(OrderView::from).toList();
    }

    /**
     * 高并发模拟（服务端 burst，突破浏览器 fetch 并发上限）：
     * PAY_SAME = N 线程并发支付同一订单（验证幂等：仅交付一次）；
     * CREATE_ORDERS = N 线程并发下单（DB 写入压测）。闩锁保证 N 线程同时起跑。
     */
    @PostMapping("/burst")
    public Map<String, Object> burst(@Valid @RequestBody PayDtos.BurstRequest req,
                                     @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                                     @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        MDC.put(TraceIdFilter.UID, String.valueOf(req.uid()));
        if ("PAY_SAME".equals(req.mode()) && (req.orderNo() == null || req.orderNo().isBlank())) {
            throw ApiException.badRequest("ORDER_NO_REQUIRED", "PAY_SAME mode requires orderNo");
        }
        if ("CREATE_ORDERS".equals(req.mode()) && (req.skuCode() == null || req.skuCode().isBlank())) {
            throw ApiException.badRequest("SKU_CODE_REQUIRED", "CREATE_ORDERS mode requires skuCode");
        }

        CountDownLatch gate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(req.count(), 64));
        try {
            List<Future<String>> futures = new ArrayList<>();
            for (int i = 0; i < req.count(); i++) {
                futures.add(pool.submit(() -> {
                    gate.await();
                    try {
                        if ("PAY_SAME".equals(req.mode())) {
                            return "PAY:" + mockChannelService.confirmPaid(req.uid(), req.orderNo()).getStatus();
                        }
                        return "CREATE:" + orderService.createOrder(req.uid(), req.skuCode(),
                                PayOrder.PayChannel.MOCK, null).order().getOrderNo();
                    } catch (Exception e) {
                        return "FAIL:" + e.getMessage();
                    }
                }));
            }
            gate.countDown();
            long start = System.currentTimeMillis();
            List<String> results = new ArrayList<>();
            for (Future<String> f : futures) {
                results.add(f.get(60, TimeUnit.SECONDS));
            }
            long elapsed = System.currentTimeMillis() - start;
            Map<String, Long> stats = results.stream().collect(
                    Collectors.groupingBy(r -> r.split(":")[0], Collectors.counting()));
            audit.audit("TEST_BURST", "mode", req.mode(), "count", req.count(), "elapsed_ms", elapsed);
            log.info("[PAY] test_burst mode={} count={} elapsed_ms={} stats={}",
                    req.mode(), req.count(), elapsed, stats);
            return Map.of("mode", req.mode(), "count", req.count(), "elapsed_ms", elapsed,
                    "stats", stats, "results", results);
        } catch (Exception e) {
            throw ApiException.badRequest("BURST_FAILED", e.toString());
        } finally {
            pool.shutdownNow();
        }
    }

    /** 二维码渲染（控制台展示支付宝沙箱收款码，手机沙箱钱包扫码）。 */
    @GetMapping(value = "/qr", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] qr(@RequestParam String text,
                     @RequestHeader(value = "X-Test-Token", required = false) String headerToken,
                     @RequestParam(value = "token", required = false) String queryToken) {
        guard(headerToken, queryToken);
        try {
            BitMatrix matrix = new QRCodeWriter()
                    .encode(text, BarcodeFormat.QR_CODE, 300, 300);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            MatrixToImageWriter.writeToStream(matrix, "PNG", out);
            return out.toByteArray();
        } catch (Exception e) {
            throw ApiException.badRequest("QR_ENCODE_FAILED", "QR code generation failed");
        }
    }

    /** 双闸门：开关关闭 → 404 隐身；令牌（可选加固）不匹配 → 401。未配置令牌 = 默认验证通过。 */
    private void guard(String headerToken, String queryToken) {
        if (!payProperties.test().enabled()) {
            throw ApiException.notFound("NOT_FOUND", "Endpoint not found");
        }
        String expected = payProperties.test().token();
        if (expected == null || expected.isBlank()) {
            return; // 未配置令牌：本机回环 + 开关即闸门，默认验证通过
        }
        if (!expected.equals(headerToken) && !expected.equals(queryToken)) {
            throw ApiException.unauthorized("UNAUTHORIZED", "Invalid test token");
        }
    }
}
