-- V8: drop a redundant pay_order index on the write hot path.
--
-- idx_pay_order_uid_status (uid, status) is a strict prefix of
-- idx_pay_order_uid_status_paid (uid, status, paid_at) added by V5. Every order insert/update
-- maintains all secondary indexes, so removing the prefix copy reduces write amplification
-- without losing a query path: uid/status lookups still use the V5 index.
ALTER TABLE pay_order DROP INDEX idx_pay_order_uid_status;
