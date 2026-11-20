-- V9: speed up ReconciliationJob's PAID/DELIVERED non-MOCK scan.
--
-- The slow query log showed:
--   SELECT ... FROM pay_order
--   WHERE status IN ('PAID','DELIVERED') AND channel <> 'MOCK' AND paid_at >= ?
--   ORDER BY last_checked_at, paid_at LIMIT 200
-- examining ~211k rows (all PAID/DELIVERED rows, mostly MOCK) because the
-- existing (status, paid_at) index does not include channel.
--
-- This composite index lets MySQL filter status + channel before paid_at, so
-- the reconciliation job no longer scans the whole PAID/DELIVERED set.
CREATE INDEX idx_pay_order_status_channel_paid
    ON pay_order (status, channel, paid_at);
