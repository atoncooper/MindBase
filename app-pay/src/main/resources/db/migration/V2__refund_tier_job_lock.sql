-- V2: refund reversal + explicit tier + cross-instance job lease + reconciliation index.
-- Compatible with both paths: the old database created by the historical schema.sql (baselined to 0) and a
-- new database (built in full by V1) both lack these columns.

-- 1) Explicit tier: delivery is no longer derived from the SKU code prefix string
ALTER TABLE pay_product
    ADD COLUMN tier VARCHAR(20) NOT NULL DEFAULT 'VIP';
UPDATE pay_product
SET tier = 'SVIP'
WHERE code LIKE 'SVIP%';

-- 2) Order: tier snapshot + refund fields
ALTER TABLE pay_order
    ADD COLUMN tier               VARCHAR(20)  NULL,
    ADD COLUMN refund_prev_status VARCHAR(20)  NULL,
    ADD COLUMN refund_no          VARCHAR(128) NULL,
    ADD COLUMN refund_reason      VARCHAR(200) NULL,
    ADD COLUMN refunded_at        DATETIME(6)  NULL;

-- Refund number unique: channel refund idempotency (the same out_request_no allows only one order record)
CREATE UNIQUE INDEX uk_pay_order_refund_no ON pay_order (refund_no);

-- 3) Cross-instance job lease (mutual exclusion for multi-replica deployments, preventing duplicate outbound calls/duplicate processing)
CREATE TABLE IF NOT EXISTS pay_job_lock
(
    name         VARCHAR(50) NOT NULL PRIMARY KEY,
    owner        VARCHAR(80) NOT NULL,
    locked_until DATETIME(6) NOT NULL,
    created_at   DATETIME(6) NOT NULL,
    updated_at   DATETIME(6) NOT NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- 4) Reconciliation scan index
CREATE INDEX idx_pay_callback_created_at ON pay_callback_log (created_at);
CREATE INDEX idx_pay_membership_event_order_no ON pay_membership_event (order_no);
