package com.mindbase.pay.controller;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.QrCodes;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.ProductService;
import com.mindbase.pay.service.TierCatalogService;
import com.mindbase.pay.service.channel.PayChannelRouter;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import lombok.RequiredArgsConstructor;
import org.slf4j.MDC;
import org.springframework.http.MediaType;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

import static com.mindbase.pay.dto.PayDtos.ChannelView;
import static com.mindbase.pay.dto.PayDtos.CreateOrderRequest;
import static com.mindbase.pay.dto.PayDtos.CreateOrderResponse;
import static com.mindbase.pay.dto.PayDtos.MembershipView;
import static com.mindbase.pay.dto.PayDtos.MockConfirmRequest;
import static com.mindbase.pay.dto.PayDtos.OrderView;
import static com.mindbase.pay.dto.PayDtos.ComparisonRow;
import static com.mindbase.pay.dto.PayDtos.ProductView;
import static com.mindbase.pay.dto.PayDtos.TierView;
import static com.mindbase.pay.dto.PayDtos.UpgradeQuote;

/**
 * User endpoints (/pay/*). APISIX forward-auth validates bili_session and injects X-Uid; this
 * service does not verify login itself (same trust model as app-task). Direct debugging requires
 * manually supplying X-Uid.
 */
@Validated
@RestController
@RequestMapping("/pay")
@RequiredArgsConstructor
public class PayUserController {

    private static final int MAX_ORDER_PAGE = 50;

    private final ProductService productService;
    private final OrderService orderService;
    private final MockChannelService mockChannelService;
    private final MembershipService membershipService;
    private final PayChannelRouter channelRouter;
    private final TierCatalogService tierCatalogService;

    @GetMapping("/products")
    public List<ProductView> products() {
        return productService.listActive().stream().map(ProductView::from).toList();
    }

    /** 会员档位简介（权益文案由 Java 侧 TierCatalog 维护，前端只渲染）。 */
    @GetMapping("/tiers")
    public List<TierView> tiers() {
        return tierCatalogService.list();
    }

    /** 权益对照表（行 = 能力，列 = 免费/VIP/SVIP）。 */
    @GetMapping("/comparison")
    public List<ComparisonRow> comparison() {
        return tierCatalogService.comparison();
    }

    /** Currently available payment channels (the frontend renders MOCK simulation / ALIPAY QR code from this). */
    @GetMapping("/channels")
    public List<ChannelView> channels() {
        return channelRouter.availableChannels().stream()
                .map(c -> new ChannelView(c.name(), true))
                .toList();
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

    /** My orders (newest -> oldest). */
    @GetMapping("/orders")
    public List<OrderView> orders(@RequestParam(value = "limit", defaultValue = "20") int limit,
                                  @RequestHeader(value = "X-Uid", required = false) String xUid) {
        long uid = resolveUid(xUid);
        int capped = Math.min(Math.max(limit, 1), MAX_ORDER_PAGE);
        return orderService.listOwnedOrders(uid, capped).stream().map(OrderView::from).toList();
    }

    @GetMapping("/orders/{orderNo}")
    public OrderView getOrder(@PathVariable @Pattern(regexp = "^PO[A-Za-z0-9]{1,62}$",
            message = "invalid orderNo") String orderNo,
                              @RequestHeader(value = "X-Uid", required = false) String xUid) {
        // 实时查单版：CREATED 订单读取时向渠道确认一次（扫码支付秒级转已开通）
        return OrderView.from(orderService.getOwnedOrderLive(resolveUid(xUid), orderNo));
    }

    /**
     * Payment QR code PNG for a pending order (Alipay face-to-face payment). The frontend renders this
     * URL as an img src, so no QR library is needed in the browser; precreate is idempotent and can be
     * refreshed repeatedly.
     */
    @GetMapping(value = "/orders/{orderNo}/qr", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] orderQr(@PathVariable @Pattern(regexp = "^PO[A-Za-z0-9]{1,62}$",
            message = "invalid orderNo") String orderNo,
                          @RequestHeader(value = "X-Uid", required = false) String xUid) {
        PayOrder order = orderService.getOwnedOrder(resolveUid(xUid), orderNo);
        if (order.getStatus() != PayOrder.OrderStatus.CREATED) {
            throw ApiException.conflict("ORDER_NOT_PAYABLE",
                    "Order is not payable in current state: " + order.getStatus());
        }
        Map<String, Object> params = orderService.paymentParams(order);
        Object qrCode = params.get("qrCode");
        if (!(qrCode instanceof String code) || code.isBlank()) {
            throw ApiException.badRequest("QR_NOT_AVAILABLE", "This channel has no scannable QR code");
        }
        return QrCodes.png(code, QrCodes.DEFAULT_SIZE);
    }

    /** 升级换购报价：当前有效会员可补差价升级的同档 SKU（商品卡展示差价用）。 */
    @GetMapping("/upgrade-quotes")
    public List<UpgradeQuote> upgradeQuotes(@RequestHeader(value = "X-Uid", required = false) String xUid) {
        return orderService.quoteUpgrades(resolveUid(xUid));
    }

    /** Cancel an unpaid order (CREATED only; idempotency is decided by the conditional update). */
    @PostMapping("/orders/{orderNo}/cancel")
    public OrderView cancelOrder(@PathVariable @Pattern(regexp = "^PO[A-Za-z0-9]{1,62}$",
            message = "invalid orderNo") String orderNo,
                                 @RequestHeader(value = "X-Uid", required = false) String xUid) {
        return OrderView.from(orderService.cancelOrder(resolveUid(xUid), orderNo));
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

    /** The M1 channel is mock; from M2 the channel returns a WeChat codeUrl / Alipay redirect string. */
    private long resolveUid(String xUid) {
        if (xUid == null || xUid.isBlank()) {
            throw ApiException.unauthorized("UNAUTHORIZED", "Missing X-Uid header (must be accessed via gateway auth)");
        }
        try {
            long uid = Long.parseLong(xUid.trim());
            if (uid <= 0) {
                throw new NumberFormatException();
            }
            MDC.put(TraceIdFilter.UID, String.valueOf(uid)); // Subsequent logs and audit records carry the uid automatically
            return uid;
        } catch (NumberFormatException e) {
            throw ApiException.unauthorized("UNAUTHORIZED", "Invalid X-Uid header");
        }
    }
}
