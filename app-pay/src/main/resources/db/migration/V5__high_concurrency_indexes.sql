-- V5: 高并发索引（SQL 审计 P2 优化包，2026-10）
-- 1) 建单频次检查：uid + status IN + paid_at >= 走 ICP，paid_at 在索引层过滤，
--    历史支付多的用户不再每次建单回表全部历史（原 (uid,status) 索引无 paid_at）
ALTER TABLE pay_order
    ADD KEY idx_pay_order_uid_status_paid (uid, status, paid_at);

-- 2) 我的订单列表：ORDER BY created_at DESC LIMIT n 走索引倒序，
--    原实现 (uid,status) 只能 uid 前缀 + 全量 filesort
ALTER TABLE pay_order
    ADD KEY idx_pay_order_uid_created (uid, created_at);

-- 3) ChannelQueryJob 扫描：created_at 在索引层过滤 + 正序走索引免 filesort，
--    原实现 (status,expires_at) 范围内所有在窗 CREATED 单回表过滤 + filesort
ALTER TABLE pay_order
    ADD KEY idx_pay_order_status_created (status, created_at);
