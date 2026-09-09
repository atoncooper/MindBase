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
import java.util.Map;

/**
 * 请求/响应 DTO 集中定义（record）。日期序列化为 ISO-8601（Jackson 默认，时区见 application.yaml）。
 * 字符串长度上限与 schema.sql 对应列宽一致：超长输入在 400 层拒绝，而非穿透到 DB 变 500。
 */
public final class PayDtos {

    private PayDtos() {
    }

    // ---------- 用户端 ----------

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
                            LocalDateTime paidAt, LocalDateTime expiresAt, LocalDateTime createdAt) {
        public static OrderView from(PayOrder o) {
            return new OrderView(o.getOrderNo(), o.getSkuCode(), o.getProductTitle(), o.getDurationDays(),
                    o.getAmountCents(), o.getChannel(), o.getStatus(),
                    o.getPaidAt(), o.getExpiresAt(), o.getCreatedAt());
        }
    }

    /** payParams 按渠道不同：MOCK 为 {type,orderNo,confirmEndpoint}；M2 起为 {type,codeUrl} 等。 */
    public record CreateOrderResponse(String orderNo, PayOrder.OrderStatus status, long amountCents,
                                      LocalDateTime expiresAt, Map<String, Object> payParams) {
    }

    public record MembershipView(String tier, boolean active, LocalDateTime expireAt, boolean autoRenew) {
        public static MembershipView from(PayMembership m, boolean active) {
            return new MembershipView(m.getTier(), active, m.getExpireAt(), m.isAutoRenew());
        }
    }

    public record MockConfirmRequest(@NotBlank @Size(max = 64) String orderNo) {
    }

    // ---------- 内部端点（主 app / 运营） ----------

    public record InternalMembershipView(long uid, String tier, boolean active, LocalDateTime expireAt) {
    }

    public record GrantRequest(@Positive long uid,
                               @Min(1) int durationDays,
                               @NotBlank @Size(max = 200) String reason) {
    }

    // ---------- 本机测试入口（/test/pay/*，默认关闭 + 令牌双闸门） ----------

    public record TestCreateOrderRequest(@Positive long uid, @NotBlank @Size(max = 50) String skuCode,
                                         @NotNull PayOrder.PayChannel channel) {
    }

    public record TestMockPayRequest(@Positive long uid, @NotBlank @Size(max = 64) String orderNo) {
    }

    /** 高并发模拟（服务端 burst）：PAY_SAME=并发支付同一订单；CREATE_ORDERS=并发下单。 */
    public record BurstRequest(@NotBlank String mode,
                               @Min(1) @Max(500) int count,
                               @Positive long uid,
                               String skuCode,
                               String orderNo) {
    }

    // ---------- 超时委托 executor（app-task 到点调用，payload 原文） ----------

    public record TimeoutExecutionRequest(@NotBlank @Size(max = 64) String orderNo, @Min(1) int version) {
    }
}
