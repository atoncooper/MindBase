package com.mindbase.pay.controller;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.ProductService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

import static com.mindbase.pay.dto.PayDtos.CreateOrderRequest;
import static com.mindbase.pay.dto.PayDtos.CreateOrderResponse;
import static com.mindbase.pay.dto.PayDtos.MembershipView;
import static com.mindbase.pay.dto.PayDtos.MockConfirmRequest;
import static com.mindbase.pay.dto.PayDtos.OrderView;
import static com.mindbase.pay.dto.PayDtos.ProductView;

/**
 * 用户端点（/pay/*）。uid 由 APISIX forward-auth 校验 bili_session 后注入 X-Uid，
 * 本服务不自验登录（与 app-task 同一信任模型）；直连调试需手动携带 X-Uid。
 */
@RestController
@RequestMapping("/pay")
@RequiredArgsConstructor
public class PayUserController {

    private final ProductService productService;
    private final OrderService orderService;
    private final MockChannelService mockChannelService;
    private final MembershipService membershipService;

    @GetMapping("/products")
    public List<ProductView> products() {
        return productService.listActive().stream().map(ProductView::from).toList();
    }

    @PostMapping("/orders")
    public CreateOrderResponse createOrder(@Valid @RequestBody CreateOrderRequest req,
                                           @RequestHeader(value = "X-Uid", required = false) String xUid) {
        long uid = resolveUid(xUid);
        OrderService.CreatedOrder created =
                orderService.createOrder(uid, req.skuCode(), req.channel(), req.idempotencyKey());
        PayOrder order = created.order();
        return new CreateOrderResponse(order.getOrderNo(), order.getStatus(), order.getAmountCents(),
                order.getExpiresAt(), created.payParams());
    }

    @GetMapping("/orders/{orderNo}")
    public OrderView getOrder(@PathVariable String orderNo,
                              @RequestHeader(value = "X-Uid", required = false) String xUid) {
        return OrderView.from(orderService.getOwnedOrder(resolveUid(xUid), orderNo));
    }

    @GetMapping("/membership")
    public MembershipView membership(@RequestHeader(value = "X-Uid", required = false) String xUid) {
        long uid = resolveUid(xUid);
        return membershipService.findByUid(uid)
                .map(m -> MembershipView.from(m, membershipService.isActive(m)))
                .orElse(new MembershipView(null, false, null, false));
    }

    @PostMapping("/mock/confirm")
    public OrderView mockConfirm(@Valid @RequestBody MockConfirmRequest req,
                                 @RequestHeader(value = "X-Uid", required = false) String xUid) {
        PayOrder order = mockChannelService.confirmPaid(resolveUid(xUid), req.orderNo());
        return OrderView.from(order);
    }

    /** M1 渠道为 mock；M2 起按渠道返回微信 codeUrl / 支付宝跳转串。 */
    private long resolveUid(String xUid) {
        if (xUid == null || xUid.isBlank()) {
            throw ApiException.unauthorized("UNAUTHORIZED", "Missing X-Uid header (must be accessed via gateway auth)");
        }
        try {
            long uid = Long.parseLong(xUid.trim());
            if (uid <= 0) {
                throw new NumberFormatException();
            }
            MDC.put(TraceIdFilter.UID, String.valueOf(uid)); // 后续日志与审计流水自动携带 uid
            return uid;
        } catch (NumberFormatException e) {
            throw ApiException.unauthorized("UNAUTHORIZED", "Invalid X-Uid header");
        }
    }
}
