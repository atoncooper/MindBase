-- V7: P0-P2 加固（2026-11）
-- 1) 未支付订单上限原子化：open_slot 唯一槽位（uid + slot 唯一，slot 仅在 CREATED 期间占用，
--    进入 PAID/CLOSED 时置 NULL）。并发建单不再依赖“先 count 再 insert”的非原子检查。
-- 2) 兜底任务公平调度：last_checked_at（最近一次被任务处理的时间）+ delivery_attempts（交付补偿次数），
--    任务按 last_checked_at 升序取，消除“最老 200 条反复处理、新单永远轮不到”的队头阻塞。
-- 3) 退款审批幂等：同一订单同一状态只允许一条（并发首次退款请求不会产生两条 PENDING）。
-- 4) ADMIN_GRANT 幂等：request_id 唯一（调用方重试/网关重放不会重复开会员）。
-- 5) ADMIN_GRANT 日额度原子计数：check-then-act 改为事务内 SELECT ... FOR UPDATE + 原子累加。

ALTER TABLE pay_order
    ADD COLUMN open_slot         TINYINT   NULL COMMENT '未支付订单占用的槽位 1..maxOpenPerUser；非 CREATED 时为 NULL',
    ADD COLUMN last_checked_at   DATETIME(6) NULL COMMENT '兜底任务最近一次处理时间（公平调度用）',
    ADD COLUMN delivery_attempts INT       NOT NULL DEFAULT 0 COMMENT '交付补偿尝试次数（毒丸订单上限）',
    ADD UNIQUE KEY uk_pay_order_uid_slot (uid, open_slot),
    ADD KEY idx_pay_order_status_last_checked (status, last_checked_at);

-- 存量 CREATED 订单补槽位（最多 10 个，与 pay.order.max-open-per-user 默认值一致）；
-- 超过 10 的保持 NULL，不阻塞后续建单（过渡态，到期由 OrderTimeoutJob 关闭）。
UPDATE pay_order o
    JOIN (SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY uid ORDER BY created_at, id) AS rn
          FROM pay_order
          WHERE status = 'CREATED') x ON x.id = o.id
SET o.open_slot = CASE WHEN x.rn <= 10 THEN x.rn ELSE NULL END;

-- 退款审批：先清理历史重复行（并发首次请求可能已产生多条同状态记录），再加唯一键
DELETE a FROM pay_refund_approval a
    JOIN pay_refund_approval b
      ON a.order_no = b.order_no AND a.status = b.status AND a.id < b.id;
ALTER TABLE pay_refund_approval
    ADD UNIQUE KEY uk_pay_refund_approval_order_status (order_no, status);

-- ADMIN_GRANT 幂等键
ALTER TABLE pay_membership_event
    ADD COLUMN request_id VARCHAR(64) NULL COMMENT '运营补偿幂等键（同一 request_id 只生效一次）',
    ADD UNIQUE KEY uk_pay_pme_request_id (request_id);

-- ADMIN_GRANT 幂等占位表：request_id 主键先占位，成功则与会员扩展同事务提交；
-- 并发重放/网关重试命中主键冲突即视为幂等命中，不会重复开会员。
CREATE TABLE IF NOT EXISTS pay_grant_idempotency
(
    request_id VARCHAR(64) NOT NULL PRIMARY KEY,
    uid        BIGINT      NOT NULL,
    created_at DATETIME(6) NOT NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- ADMIN_GRANT 日额度原子计数（按本地自然日；事务内锁定该行后校验并累加）
CREATE TABLE IF NOT EXISTS pay_grant_quota
(
    day        DATE         NOT NULL PRIMARY KEY,
    cnt        INT          NOT NULL DEFAULT 0 COMMENT '当日 ADMIN_GRANT 次数',
    days       INT          NOT NULL DEFAULT 0 COMMENT '当日 ADMIN_GRANT 总天数',
    updated_at DATETIME(6)  NOT NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
