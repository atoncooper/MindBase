package com.mindbase.pay.dto;

import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * Central request/response DTO definitions (records). Dates serialize as ISO-8601 (Jackson default;
 * see application.yaml for the time zone). String length limits match the corresponding column widths
 * in the Flyway migrations: over-long input is rejected at the 400 layer rather than passing through to the DB
 * and becoming a 500.
 */
public final class PayDtos {

    private PayDtos() {
    }

    // ---------- User-facing ----------

    public record ProductView(String code, String title, int durationDays, long priceCents, String status) {
        public static ProductView from(PayProduct p) {
            return new ProductView(p.getCode(), p.getTitle(), p.getDurationDays(),
                    p.getPriceCents(), p.getStatus().name());
        }
    }

    public record CreateOrderRequest(@NotBlank @Size(max = 50) String skuCode,
                                     @NotNull PayOrder.PayChannel channel,
                                     @Size(max = 64) String idempotencyKey) {
    }

    public record OrderView(String orderNo, String skuCode, String productTitle, int durationDays,
                            long amountCents, PayOrder.PayChannel channel, PayOrder.OrderStatus status,
                            LocalDateTime paidAt, LocalDateTime expiresAt, LocalDateTime createdAt,
                            String tier, LocalDateTime refundedAt, String channelTradeNo,
                            String buyerLogonId, String buyerUserId) {
        public static OrderView from(PayOrder o) {
            return new OrderView(o.getOrderNo(), o.getSkuCode(), o.getProductTitle(), o.getDurationDays(),
                    o.getAmountCents(), o.getChannel(), o.getStatus(),
                    o.getPaidAt(), o.getExpiresAt(), o.getCreatedAt(),
                    o.getTier(), o.getRefundedAt(), o.getChannelTradeNo(),
                    o.getBuyerLogonId(), o.getBuyerUserId());
        }
    }

    /** Available payment channels (the frontend renders from this: MOCK local simulation / ALIPAY QR code). */
    public record ChannelView(String code, boolean enabled) {
    }

    /** payParams differ by channel: MOCK is {type,orderNo,confirmEndpoint}; from M2, {type,codeUrl}, etc. */
    public record CreateOrderResponse(String orderNo, PayOrder.OrderStatus status, long amountCents,
                                      LocalDateTime expiresAt, Map<String, Object> payParams) {
    }

    public record MembershipView(String tier, boolean active, LocalDateTime expireAt, boolean autoRenew) {
        public static MembershipView from(PayMembership m, boolean active) {
            return new MembershipView(m.getTier(), active, m.getExpireAt(), m.isAutoRenew());
        }
    }

    /** 会员档位简介（内容由 TierCatalog 在 Java 侧维护，前端只渲染）。 */
    public record TierView(String tier, String name, String tagline, List<String> benefits,
                           String markdown) {
    }

    /** 权益对照表的一行（feature = 能力名，三列 = 各档位权益）。 */
    public record ComparisonRow(String feature, String free, String vip, String svip) {
    }

    public record MockConfirmRequest(@NotBlank @Size(max = 64) String orderNo) {
    }

    // ---------- Internal endpoints (main app / operations) ----------

    public record InternalMembershipView(long uid, String tier, boolean active, LocalDateTime expireAt) {
    }

    public record GrantRequest(@Positive long uid,
                               @Min(1) @Max(3650) int durationDays,
                               @NotBlank @Size(max = 200) String reason,
                               @Size(max = 20) String tier) {
    }

    /** Operations refund (/internal/pay/orders/{orderNo}/refund, key-auth). */
    public record RefundRequest(@NotBlank @Size(max = 200) String reason,
                                Boolean revokeMembership) {
    }

    // ---------- Local test entry points (/test/pay/*, off by default + token double gate) ----------

    public record TestCreateOrderRequest(@Positive long uid, @NotBlank @Size(max = 50) String skuCode,
                                         @NotNull PayOrder.PayChannel channel) {
    }

    public record TestMockPayRequest(@Positive long uid, @NotBlank @Size(max = 64) String orderNo) {
    }

    /** High-concurrency simulation (server-side burst): PAY_SAME=pay the same order concurrently; CREATE_ORDERS=create orders concurrently. */
    public record BurstRequest(@NotBlank String mode,
                               @Min(1) @Max(500) int count,
                               @Positive long uid,
                               String skuCode,
                               String orderNo) {
    }

    // ---------- Timeout delegation executor (called by app-task at deadline, raw payload) ----------

    public record TimeoutExecutionRequest(@NotBlank @Size(max = 64) String orderNo, @Min(1) int version) {
    }
}
