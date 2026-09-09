-- app-pay schema（MyBatis-Plus 不做自动建表，启动时经 spring.sql.init 执行；
-- 全部 CREATE TABLE IF NOT EXISTS，幂等。M4 引入 Flyway 后本文件转为基线版本。）
-- 金额一律 long 分；时间 DATETIME(6)，JDBC/JVM 时区固定 Asia/Shanghai。

CREATE TABLE IF NOT EXISTS pay_product
(
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    code          VARCHAR(50)  NOT NULL,
    title         VARCHAR(100) NOT NULL,
    duration_days INT          NOT NULL,
    price_cents   BIGINT       NOT NULL,
    status        VARCHAR(20)  NOT NULL,
    sort          INT          NOT NULL DEFAULT 0,
    created_at    DATETIME(6)  NOT NULL,
    updated_at    DATETIME(6)  NOT NULL,
    UNIQUE KEY uk_pay_product_code (code)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pay_order
(
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_no         VARCHAR(64)  NOT NULL,
    uid              BIGINT       NOT NULL,
    sku_code         VARCHAR(50)  NOT NULL,
    product_title    VARCHAR(100) NOT NULL,
    duration_days    INT          NOT NULL,
    amount_cents     BIGINT       NOT NULL,
    channel          VARCHAR(20)  NOT NULL,
    status           VARCHAR(20)  NOT NULL,
    -- 乐观锁版本：创建=1，每次状态迁移原子自增；app-task 超时委托携带注册时版本，不匹配即作废
    version          INT          NOT NULL DEFAULT 1,
    channel_trade_no VARCHAR(128) NULL,
    idempotency_key  VARCHAR(64)  NULL,
    fail_reason      VARCHAR(200) NULL,
    expires_at       DATETIME(6)  NOT NULL,
    paid_at          DATETIME(6)  NULL,
    closed_at        DATETIME(6)  NULL,
    created_at       DATETIME(6)  NOT NULL,
    updated_at       DATETIME(6)  NOT NULL,
    UNIQUE KEY uk_pay_order_no (order_no),
    UNIQUE KEY uk_pay_order_channel_trade_no (channel_trade_no),
    UNIQUE KEY uk_pay_order_idempotency_key (idempotency_key),
    KEY idx_pay_order_uid_status (uid, status),
    -- 定时 job 复合索引：等值 status 前缀 + 范围列，保证随历史增长仍是有界扫描
    KEY idx_pay_order_status_expires (status, expires_at),
    KEY idx_pay_order_status_paid_at (status, paid_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pay_callback_log
(
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_no         VARCHAR(64)  NOT NULL,
    channel          VARCHAR(20)  NOT NULL,
    payload_masked   TEXT         NULL,
    signature_result VARCHAR(20)  NOT NULL,
    handle_result    VARCHAR(30)  NOT NULL,
    message          VARCHAR(200) NULL,
    created_at       DATETIME(6)  NOT NULL,
    KEY idx_pay_callback_order_no (order_no)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pay_membership
(
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    uid           BIGINT      NOT NULL,
    tier          VARCHAR(20) NOT NULL,
    expire_at     DATETIME(6) NOT NULL,
    auto_renew    TINYINT(1)  NOT NULL DEFAULT 0,
    last_order_no VARCHAR(64) NULL,
    created_at    DATETIME(6) NOT NULL,
    updated_at    DATETIME(6) NOT NULL,
    UNIQUE KEY uk_pay_membership_uid (uid)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pay_membership_event
(
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    uid           BIGINT       NOT NULL,
    type          VARCHAR(20)  NOT NULL,
    order_no      VARCHAR(64)  NULL,
    days          INT          NOT NULL,
    expire_before DATETIME(6)  NOT NULL,
    expire_after  DATETIME(6)  NOT NULL,
    reason        VARCHAR(200) NULL,
    created_at    DATETIME(6)  NOT NULL,
    KEY idx_pay_membership_event_uid (uid)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
