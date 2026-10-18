-- V6: 升级换购（同档补差价升级，2026-10）
-- 会员有效期内可对同档/升档 SKU「补差价升级」：金额 = 新 SKU 价 − 旧单价，
-- 交付天数 = 新 SKU 天数 − 旧单天数（交付顺延 → 总时长 = 原购买日起的新套餐全长）。
-- upgrade_from_order_no 指向基准订单（会员 last_order_no，须 DELIVERED）；
-- 支付确认时的档位墙对升级单豁免（同档按设计）。
ALTER TABLE pay_order
    ADD COLUMN upgrade_from_order_no VARCHAR(64) NULL,
    ADD KEY idx_pay_order_upgrade_from (upgrade_from_order_no);
