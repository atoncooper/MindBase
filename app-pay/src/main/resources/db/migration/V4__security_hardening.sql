-- V4: 安全加固（P1/P2，2026-10）
-- 1) 退款双人复核（maker-checker）：/internal/pay/orders/{orderNo}/refund 第一次调用只登记
--    PENDING 请求（maker），由第二操作人（checker，!= maker）confirm 后才进入既有
--    REFUNDING -> REFUNDED 流程；PENDING/APPROVED/REJECTED 全程留痕，幂等可重放。
CREATE TABLE IF NOT EXISTS pay_refund_approval
(
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_no      VARCHAR(64)  NOT NULL,
    maker         VARCHAR(64)  NOT NULL,
    maker_reason  VARCHAR(200) NOT NULL,
    status        VARCHAR(20)  NOT NULL,
    checker       VARCHAR(64)  NULL,
    check_reason  VARCHAR(200) NULL,
    created_at    DATETIME(6)  NOT NULL,
    decided_at    DATETIME(6)  NULL,
    KEY idx_pay_refund_approval_order (order_no),
    KEY idx_pay_refund_approval_status (status, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- 2) ADMIN_GRANT 日额度熔断按 (type, created_at) 聚合：无此索引则每日计数会全表扫描
ALTER TABLE pay_membership_event
    ADD KEY idx_pay_pme_type_created (type, created_at);
