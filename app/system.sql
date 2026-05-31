-- ============================================================
-- Bilibili RAG 知识库系统 — 完整数据库设计
-- ============================================================
-- 目标数据库：MySQL 8.0+ / PostgreSQL 15+
-- 本文件以 MySQL 语法为主，PG 差异以注释标注在每条 DDL 上方。
-- ============================================================
-- 结构概览：
--   1. 用户中心（13 张表）
--   2. 业务表（9 张表，uid 外键）
--   3. 共享数据表（视频/分P，无用户归属）
--   4. ChromaDB 向量数据库（注释说明）
-- ============================================================
-- ⚠️ 文档形（document-shape）表已迁出到 MongoDB：
--     - operation_log / chat_messages / quiz_questions / quiz_answers
-- ============================================================

-- PG: 去掉以下 3 行，改为 CREATE DATABASE bilirag;
CREATE DATABASE IF NOT EXISTS bilirag
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_0900_ai_ci;


-- ============================================================
-- 一、用户中心（12 张表）
-- ============================================================

-- -----------------------------------------------------------
-- 1. users — 用户核心表
-- -----------------------------------------------------------
-- PG: uid BIGINT PRIMARY KEY (same)
CREATE TABLE users (
    uid             BIGINT PRIMARY KEY,
    status          VARCHAR(20) DEFAULT 'active',

    -- 身份标识 + 登录凭证
    email           VARCHAR(200) UNIQUE,
    phone           VARCHAR(20)  UNIQUE,
    password_hash   VARCHAR(255),                     -- bcrypt, nullable = OAuth-only
    email_verified  BOOLEAN DEFAULT FALSE,
    phone_verified  BOOLEAN DEFAULT FALSE,

    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP
);

-- -----------------------------------------------------------
-- 2. user_oauth — 第三方登录绑定
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE user_oauth (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    uid             BIGINT NOT NULL,
    provider        VARCHAR(32) NOT NULL,
    provider_uid    VARCHAR(64) NOT NULL,
    email           VARCHAR(200),                    -- OAuth 返回的邮箱（Google/微信等）
    union_id        VARCHAR(64),
    access_token    TEXT,
    refresh_token   TEXT,
    expires_at      TIMESTAMP,
    raw_data        TEXT,
    is_primary      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,
    UNIQUE (provider, provider_uid),
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_oauth_uid ON user_oauth(uid);

-- -----------------------------------------------------------
-- 3. user_tokens — Token session table
-- -----------------------------------------------------------
-- PG: session_token VARCHAR(128) PRIMARY KEY (same)
CREATE TABLE user_tokens (
    session_token   VARCHAR(128) PRIMARY KEY,
    uid             BIGINT NOT NULL,
    device_id       VARCHAR(64),
    token_type      VARCHAR(20) DEFAULT 'access',
    expires_at      TIMESTAMP,
    ip              VARCHAR(64),
    user_agent      TEXT,
    is_revoked      BOOLEAN DEFAULT FALSE,
    last_active_at  TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_tokens_uid   ON user_tokens(uid);
CREATE INDEX idx_user_tokens_token ON user_tokens(session_token);

-- -----------------------------------------------------------
-- 4. user_device — 设备管理表
-- -----------------------------------------------------------
CREATE TABLE user_device (
    device_id       VARCHAR(64) PRIMARY KEY,
    uid             BIGINT NOT NULL,
    device_type     VARCHAR(20),
    device_name     VARCHAR(100),
    os              VARCHAR(50),
    os_version      VARCHAR(50),
    browser         VARCHAR(100),
    browser_version VARCHAR(50),
    fingerprint     VARCHAR(128),
    trust_level     VARCHAR(20) DEFAULT 'unknown',
    last_active_at  TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid),
    UNIQUE (uid, fingerprint)
);
CREATE INDEX idx_user_device_uid ON user_device(uid);

-- -----------------------------------------------------------
-- 5. user_profile — 用户资料表
-- -----------------------------------------------------------
CREATE TABLE user_profile (
    uid             BIGINT PRIMARY KEY,
    nickname        VARCHAR(100),
    avatar          VARCHAR(500),
    bio             TEXT,
    birthday        DATE,
    gender          VARCHAR(10),
    location        VARCHAR(100),
    timezone        VARCHAR(50),
    language        VARCHAR(20),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);

-- -----------------------------------------------------------
-- 6. user_tags — 用户标签定义表
-- -----------------------------------------------------------
-- PG: tag_id SERIAL PRIMARY KEY
CREATE TABLE user_tags (
    tag_id          INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL,
    category        VARCHAR(50),
    color           VARCHAR(20),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------
-- 7. user_tag_link — 用户标签关联表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE user_tag_link (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    uid             BIGINT NOT NULL,
    tag_id          INT NOT NULL,
    created_by      BIGINT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid)   REFERENCES users(uid),
    FOREIGN KEY (tag_id) REFERENCES user_tags(tag_id),
    UNIQUE (uid, tag_id)
);
CREATE INDEX idx_user_tag_link_uid ON user_tag_link(uid);

-- -----------------------------------------------------------
-- 8. user_account — 账户余额表
-- -----------------------------------------------------------
CREATE TABLE user_account (
    uid               BIGINT PRIMARY KEY,
    balance           DECIMAL(18,4) DEFAULT 0,
    frozen_balance    DECIMAL(18,4) DEFAULT 0,
    total_consumed    DECIMAL(18,4) DEFAULT 0,
    total_recharged   DECIMAL(18,4) DEFAULT 0,
    currency          VARCHAR(10) DEFAULT 'CNY',
    last_transaction_at TIMESTAMP,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);

-- -----------------------------------------------------------
-- 9. user_transaction — 交易流水表
-- -----------------------------------------------------------
CREATE TABLE user_transaction (
    transaction_id  VARCHAR(64) PRIMARY KEY,
    uid             BIGINT NOT NULL,
    type            VARCHAR(20) NOT NULL,
    amount          DECIMAL(18,4) NOT NULL,
    balance_before  DECIMAL(18,4),
    balance_after   DECIMAL(18,4),
    description     TEXT,
    reference_id    VARCHAR(128),
    reference_type  VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'success',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_transaction_uid ON user_transaction(uid);
CREATE INDEX idx_user_transaction_ref ON user_transaction(reference_id);

-- -----------------------------------------------------------
-- 10. rbac_role — 角色表
-- -----------------------------------------------------------
CREATE TABLE rbac_role (
    role_id         VARCHAR(64) PRIMARY KEY,
    name            VARCHAR(50) NOT NULL,
    description     TEXT,
    is_system       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------
-- 11. rbac_permission — 权限表
-- -----------------------------------------------------------
CREATE TABLE rbac_permission (
    permission_id   VARCHAR(64) PRIMARY KEY,
    name            VARCHAR(50) NOT NULL,
    resource        VARCHAR(100) NOT NULL,
    action          VARCHAR(50) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------
-- 12. rbac_role_permission — 角色权限关联表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE rbac_role_permission (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    role_id         VARCHAR(64) NOT NULL,
    permission_id   VARCHAR(64) NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id)       REFERENCES rbac_role(role_id),
    FOREIGN KEY (permission_id) REFERENCES rbac_permission(permission_id),
    UNIQUE (role_id, permission_id)
);

-- -----------------------------------------------------------
-- 13. rbac_user_role — 用户角色关联表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE rbac_user_role (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    uid             BIGINT NOT NULL,
    role_id         VARCHAR(64) NOT NULL,
    granted_by      BIGINT,
    granted_at      TIMESTAMP,
    expires_at      TIMESTAMP,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid)    REFERENCES users(uid),
    FOREIGN KEY (role_id) REFERENCES rbac_role(role_id)
);
CREATE INDEX idx_rbac_user_role_uid ON rbac_user_role(uid);

-- -----------------------------------------------------------
-- 14. verification_codes — 邮箱/手机号验证码
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE verification_codes (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    uid             BIGINT NOT NULL,
    target          VARCHAR(200) NOT NULL,               -- email or phone
    type            VARCHAR(20) NOT NULL,                -- email / sms
    purpose         VARCHAR(32) NOT NULL,                -- bind / change / reset_password
    code            VARCHAR(10) NOT NULL,
    expires_at      TIMESTAMP NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_vc_target_purpose ON verification_codes(target, purpose);
CREATE INDEX idx_vc_uid            ON verification_codes(uid);


-- ============================================================
-- 二、业务表（12 张，uid 外键）
-- ============================================================

-- -----------------------------------------------------------
-- 15. favorite_folders — 收藏夹记录表
-- -----------------------------------------------------------
-- 数据来源: B站 API /x/v3/fav/folder/created/list-all
-- 同步策略: 每次 GET /favorites/list 时 upsert（按 uid+media_id）
-- 级联规则: 删除文件夹 → CASCADE 删除其下所有 favorite_videos
-- 兼容字段: session_id / fid 为旧路由（knowledge.py / chat.py）兼容，新代码不依赖
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE favorite_folders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    uid             BIGINT NOT NULL,
    session_id      VARCHAR(64),                    -- [deprecated] 旧 session 体系兼容，新路由 nullable
    media_id        BIGINT NOT NULL,                -- B站收藏夹 ID（64-bit）
    fid             BIGINT,                         -- [deprecated] 旧原始 ID，新路由不写
    title           VARCHAR(200) NOT NULL,
    media_count     INT DEFAULT 0,                  -- 视频总数（同步时更新）
    is_default      BOOLEAN DEFAULT FALSE,          -- 是否默认收藏夹
    is_selected     BOOLEAN DEFAULT TRUE,           -- 用户是否勾选用于知识库
    last_sync_at    TIMESTAMP,                      -- 上次全量同步时间
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,                      -- 软删除
    FOREIGN KEY (uid) REFERENCES users(uid),
    UNIQUE (uid, media_id)                          -- 同一用户同一收藏夹唯一
);
CREATE INDEX idx_favorite_folders_uid ON favorite_folders(uid);

-- -----------------------------------------------------------
-- 16. chat_sessions — 聊天会话表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE chat_sessions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    chat_session_id VARCHAR(64) NOT NULL UNIQUE,
    uid             BIGINT NOT NULL,
    title           VARCHAR(200),
    status          VARCHAR(20) DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_chat_sessions_chat_session_id ON chat_sessions(chat_session_id);
CREATE INDEX idx_chat_sessions_uid             ON chat_sessions(uid);

-- -----------------------------------------------------------
-- 17. user_embedding_configs — 用户 Embedding 配置表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE user_embedding_configs (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    uid                 BIGINT NOT NULL,
    name                VARCHAR(64) NOT NULL,
    provider            VARCHAR(32) NOT NULL,
    api_key_encrypted   TEXT NOT NULL,
    base_url            TEXT,
    model               TEXT,
    is_default          BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_embedding_configs_uid ON user_embedding_configs(uid);

-- -----------------------------------------------------------
-- 18. user_asr_configs — 用户 ASR 语音识别配置表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE user_asr_configs (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    uid                 BIGINT NOT NULL,
    name                VARCHAR(64) NOT NULL,
    provider            VARCHAR(32) NOT NULL,
    api_key_encrypted   TEXT NOT NULL,
    base_url            TEXT,
    model               TEXT,
    is_default          BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_asr_configs_uid ON user_asr_configs(uid);

-- -----------------------------------------------------------
-- 19. user_credentials — 用户多 Provider LLM API Key 配置表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE user_credentials (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    uid                 BIGINT NOT NULL,
    name                VARCHAR(64) NOT NULL,
    provider            VARCHAR(32) NOT NULL,
    api_key_encrypted   TEXT NOT NULL,
    base_url            TEXT,
    default_model       TEXT,
    is_default          BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_user_credentials_uid ON user_credentials(uid);

-- -----------------------------------------------------------
-- 20. credential_usage — 凭证用量记录表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE credential_usage (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    uid                 BIGINT NOT NULL,
    credential_id       INT,
    provider            VARCHAR(32),
    model               VARCHAR(64),
    prompt_tokens       INT DEFAULT 0,
    completion_tokens   INT DEFAULT 0,
    total_tokens        INT DEFAULT 0,
    api_calls           INT DEFAULT 1,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_credential_usage_uid ON credential_usage(uid);

-- -----------------------------------------------------------
-- 21. quiz_sets — 题目集
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE quiz_sets (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    quiz_uuid           VARCHAR(64) NOT NULL UNIQUE,
    uid                 BIGINT NOT NULL,
    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    question_count      INT DEFAULT 10,
    type_distribution   TEXT,
    difficulty          VARCHAR(20) DEFAULT 'medium',
    folder_ids          TEXT,
    source_type         VARCHAR(20) DEFAULT 'folder',
    source_pages        TEXT,
    bvid_count          INT DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'generating',
    error_message       TEXT,
    total_score         INT DEFAULT 100,
    passing_score       INT DEFAULT 60,
    completed_at        TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_quiz_sets_quiz_uuid ON quiz_sets(quiz_uuid);
CREATE INDEX idx_quiz_sets_uid       ON quiz_sets(uid);

-- -----------------------------------------------------------
-- 22. quiz_submissions — 提交记录
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE quiz_submissions (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    submission_uuid         VARCHAR(64) NOT NULL UNIQUE,
    quiz_uuid               VARCHAR(64) NOT NULL,
    uid                     BIGINT NOT NULL,
    total_score             INT,
    auto_score              INT,
    manual_score            INT,
    passing_score           INT,
    is_complete             BOOLEAN DEFAULT FALSE,
    is_passed               BOOLEAN,
    correct_count           INT DEFAULT 0,
    total_question_count    INT DEFAULT 0,
    time_spent_seconds      INT,
    started_at              TIMESTAMP,
    submitted_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    graded_at               TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_quiz_submissions_quiz_uuid ON quiz_submissions(quiz_uuid);
CREATE INDEX idx_quiz_submissions_uid       ON quiz_submissions(uid);

-- -----------------------------------------------------------
-- 23. quiz_answers — per-question answer detail
-- -----------------------------------------------------------
-- One row per question in a submission. Stores user answer,
-- grading result, and keyword match metrics.
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE quiz_answers (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    submission_uuid         VARCHAR(64) NOT NULL,
    question_uuid           VARCHAR(64) NOT NULL,
    question_type           VARCHAR(20) NOT NULL,
    user_answer             JSON NOT NULL,              -- "A" | ["A","C"] | "text answer"
    user_answer_text        TEXT,
    is_correct              BOOLEAN,
    auto_score              INT,
    manual_score            INT,
    final_score             INT,
    correct_answer_snapshot JSON NOT NULL,              -- snapshot at grading time
    matched_keywords        JSON,
    keyword_match_rate      FLOAT,
    grading_detail          JSON,
    submitted_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    graded_at               TIMESTAMP
);
CREATE INDEX idx_quiz_answers_submission_uuid ON quiz_answers(submission_uuid);
CREATE INDEX idx_quiz_answers_question_uuid  ON quiz_answers(question_uuid);

-- -----------------------------------------------------------
-- 23. async_tasks — 通用异步任务表
-- -----------------------------------------------------------
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE async_tasks (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    task_id         VARCHAR(64) NOT NULL UNIQUE,
    uid             BIGINT NOT NULL,
    task_type       VARCHAR(20) NOT NULL,
    target          TEXT NOT NULL,
    status          VARCHAR(20) DEFAULT 'pending',
    progress        INT DEFAULT 0,
    steps           TEXT,
    result          TEXT,
    error           TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP,
    deleted_at      TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES users(uid)
);
CREATE INDEX idx_async_tasks_task_id ON async_tasks(task_id);
CREATE INDEX idx_async_tasks_uid     ON async_tasks(uid);


-- ============================================================
-- 三、共享数据表（无用户归属，全局共享）
-- ============================================================
-- 视频主键使用 AV 号 (INT) 而非 BV 号 (VARCHAR), 通过 bv_to_av() 算法映射。
-- ASR 文本内容（content）存储在 MongoDB，不放在关系型数据库。
-- SQL 只存元数据 + 处理状态 + 向量状态。

-- -----------------------------------------------------------
-- 24. collection — 收藏夹同步视频元数据
-- -----------------------------------------------------------
-- 数据来源: B站 API /x/v3/fav/resource/list
-- 主键 (media_id, bvid): 同一视频可出现在不同收藏夹, 各自独立记录
-- 查询: SELECT * FROM collection WHERE media_id = ? — 无需 JOIN
CREATE TABLE collection (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    media_id        BIGINT NOT NULL,                    -- B站 collection ID
    bvid            VARCHAR(20) NOT NULL,
    cid             BIGINT,
    title           VARCHAR(500) NOT NULL,
    cover           VARCHAR(500),
    duration        INT,
    owner_name      VARCHAR(100),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (media_id, bvid)
);
CREATE INDEX idx_collection_media_id ON collection(media_id);

-- -----------------------------------------------------------
-- 25. video_cache — 视频元数据缓存表（知识库处理流水线）
-- -----------------------------------------------------------
-- 只存 B站 API 返回的视频元信息。不含 ASR 文本（在 MongoDB asr_documents）。
CREATE TABLE video_cache (
    id              INT PRIMARY KEY,               -- av_id, computed by bv_to_av(bvid)
    bvid            VARCHAR(20) NOT NULL UNIQUE,   -- original BV string for reverse lookup
    cid             BIGINT,                           -- default cid (first page)
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    owner_name      VARCHAR(100),
    owner_mid       INT,
    duration        INT,                           -- seconds
    pic_url         VARCHAR(500),
    page_count      INT DEFAULT 1,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP
);
CREATE INDEX idx_video_cache_bvid ON video_cache(bvid);

-- -----------------------------------------------------------
-- 26. favorite_videos — 收藏夹-视频关联表
-- -----------------------------------------------------------
-- 关联链路: favorite_folders.id → favorite_videos.folder_id → collection.id
-- 数据来源: B站 API /x/v3/fav/resource/list（按收藏夹分页拉取）
-- 同步策略: 每次拉取时 upsert collection（元数据）→ upsert 本表（关联）
-- 级联规则: 删除 folder → CASCADE；删除 collection 行 → CASCADE
-- 兼容字段: bvid 为旧路由（knowledge.py / chat.py）直接查 BV 号用，新路由通过 video_id JOIN
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE favorite_videos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    folder_id       INT NOT NULL,                  -- FK → favorite_folders.id
    video_id        INT NOT NULL,                  -- FK → collection.id (av_id, computed by bv_to_av(bvid))
    bvid            VARCHAR(20),                   -- [deprecated] 旧路由兼容，新路由通过 video_id JOIN collection 获取
    is_selected     BOOLEAN DEFAULT TRUE,          -- 用户是否勾选用于知识库
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (folder_id) REFERENCES favorite_folders(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id)  REFERENCES collection(id)     ON DELETE CASCADE,
    UNIQUE (folder_id, video_id)                   -- 同一收藏夹内同一视频唯一
);
CREATE INDEX idx_favorite_videos_folder_id ON favorite_videos(folder_id);
CREATE INDEX idx_favorite_videos_video_id  ON favorite_videos(video_id);

-- 查询收藏夹内视频列表（含元数据）的标准 JOIN:
-- SELECT fv.id, fv.is_selected, c.bvid, c.title, c.owner_name, c.duration, c.cover
-- FROM favorite_videos fv
-- JOIN collection c ON c.id = fv.video_id
-- WHERE fv.folder_id = ?;

-- -----------------------------------------------------------
-- 27. video — 视频分P信息表
-- -----------------------------------------------------------
-- 每个分P一行。不存 ASR 文本（在 MongoDB asr_documents）。
-- version 指向 MongoDB asr_documents 中的最新版本。
-- is_processed: ASR 是否已获取（内容在 MongoDB）。
-- is_vectorized: 向量是否已写入 ChromaDB。
CREATE TABLE video (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    video_id             INT NOT NULL,              -- bv_to_av(bvid), FK → video_cache.id
    bvid                 VARCHAR(20) NOT NULL,
    cid                  BIGINT NOT NULL,              -- Bilibili cid
    page_index           INT NOT NULL,              -- 0-based
    page_title           VARCHAR(500),
    is_processed         BOOLEAN DEFAULT FALSE,     -- ASR content exists in MongoDB
    version              INT DEFAULT 1,             -- current ASR version (→ asr_documents.version)
    is_vectorized        VARCHAR(20) DEFAULT 'pending',  -- pending | processing | done | failed
    vectorized_at        TIMESTAMP,
    vector_chunk_count   INT DEFAULT 0,
    vector_error         TEXT,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES video_cache(id),
    UNIQUE (video_id, cid),
    UNIQUE (video_id, page_index)
);
CREATE INDEX idx_video_bvid     ON video(bvid);
CREATE INDEX idx_video_video_id ON video(video_id);

-- -----------------------------------------------------------
-- 27. video_versions — ASR version history per page
-- -----------------------------------------------------------
-- Each row records a specific version of the ASR content for a
-- bvid+cid page.  is_latest=true marks the active version.
-- PG: id SERIAL PRIMARY KEY
CREATE TABLE video_versions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    bvid            VARCHAR(20) NOT NULL,
    cid             BIGINT NOT NULL,
    page_index      INT NOT NULL,
    version         INT NOT NULL,
    content_source  VARCHAR(20),            -- asr | user_edit
    is_latest       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (bvid, cid, version)
);
CREATE INDEX idx_video_versions_bvid ON video_versions(bvid);


-- ============================================================
-- 四、MongoDB 文档集合 + ChromaDB 向量库
-- ============================================================

-- -----------------------------------------------------------
-- MongoDB: asr_documents — ASR 转写文本内容
-- -----------------------------------------------------------
-- 每个分P的 ASR 内容独立存储为一条文档。
-- version 字段实现多版本管理；is_latest 标记当前有效版本。
--
-- Collection: asr_documents
--   {
--     "_id":               ObjectId,
--     "video_id":          170001,               -- → SQL video_cache.id (av_id)
--     "bvid":              "BV1xx411c7mD",       -- 冗余，方便直接查询
--     "cid":               12345678,
--     "page_index":        0,
--     "page_title":        "P1: 课程介绍",
--     "content":           "欢迎来到本课程...",    -- ASR / subtitle 全文
--     "content_source":    "asr",                -- asr | subtitle | user_edit
--     "version":           1,
--     "is_latest":         true,
--     "created_at":        ISODate("2026-05-27T10:00:00Z")
--   }
--
-- Indexes:
--   { "video_id": 1, "cid": 1, "version": -1 }    — 按版本查询
--   { "video_id": 1, "cid": 1, "is_latest": 1 }   — 查最新版本
--   { "bvid": 1 }                                  — BV 号反向查询
--
-- 与 SQL 的关系：
--   video.version = asr_documents.version (当前最新版本号)
--   video.is_processed = (asr_documents 中存在 is_latest=true 的记录)


-- -----------------------------------------------------------
-- 28. arc_meta — 视频结构化元数据 (1:1 with video)
-- -----------------------------------------------------------
-- AI 提取 + 用户编辑的结构化信息。
-- video_id FK → video.id, ON DELETE CASCADE.
CREATE TABLE arc_meta (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    video_id        INT NOT NULL UNIQUE,            -- FK → video.id
    summary         TEXT,                            -- AI 摘要
    keywords        JSON,                            -- ["关键词1", "关键词2"]
    topics          JSON,                            -- [{"name": "分类", "confidence": 0.9}]
    difficulty      VARCHAR(20),                     -- beginner / intermediate / advanced
    word_count      INT DEFAULT 0,
    reading_time    INT DEFAULT 0,
    language        VARCHAR(10),                     -- zh / en / mix
    has_code        BOOLEAN DEFAULT FALSE,
    has_math        BOOLEAN DEFAULT FALSE,
    is_tutorial     BOOLEAN DEFAULT FALSE,
    user_tags       JSON,                            -- 用户自定义标签
    notes           TEXT,                            -- 用户笔记
    extracted_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES video(id) ON DELETE CASCADE
);
CREATE INDEX idx_arc_meta_video_id   ON arc_meta(video_id);
CREATE INDEX idx_arc_meta_difficulty ON arc_meta(difficulty);
CREATE INDEX idx_arc_meta_language   ON arc_meta(language);


-- -----------------------------------------------------------
-- ChromaDB: bilibili_videos — 向量索引
-- -----------------------------------------------------------
-- 存储方式: LangChain Chroma (持久化目录: data/chroma/)
-- 文本来源: MongoDB asr_documents.content → 语义分块 → embedding
-- Metadata 结构：
--   {
--     "video_id":         170001,          -- → SQL video_cache.id
--     "cid":              12345678,        -- → SQL video.cid
--     "title":            "视频标题",
--     "page_index":       0,
--     "page_title":       "P1. 引言",
--     "source":           "asr",
--     "chunk_index":      0,
--     "chunk_id":         "170001:0:0",
--     "section_title":    "章节标题",
--     "content_type":     "正文",
--     "embedding_version":"v1",
--     "url":              "https://www.bilibili.com/video/BV1xxxxx?p=1"
--   }


-- ============================================================
-- 五、索引汇总

-- 用户中心索引
--   idx_user_oauth_uid              ON user_oauth(uid)
--   idx_user_tokens_uid             ON user_tokens(uid)
--   idx_user_tokens_token           ON user_tokens(session_token)
--   idx_user_device_uid             ON user_device(uid)
--   idx_user_tag_link_uid           ON user_tag_link(uid)
--   idx_user_transaction_uid        ON user_transaction(uid)
--   idx_user_transaction_ref        ON user_transaction(reference_id)
--   idx_rbac_user_role_uid          ON rbac_user_role(uid)
--   idx_vc_target_purpose           ON verification_codes(target, purpose)
--   idx_vc_uid                      ON verification_codes(uid)
-- ⚠️ operation_log 索引已迁出到 MongoDB（30 天 TTL）

-- 业务表索引
--   idx_favorite_folders_uid        ON favorite_folders(uid)
--   idx_chat_sessions_uid           ON chat_sessions(uid)
--   idx_chat_sessions_chat_session_id ON chat_sessions(chat_session_id)
--   idx_user_embedding_configs_uid  ON user_embedding_configs(uid)
--   idx_user_asr_configs_uid        ON user_asr_configs(uid)
--   idx_user_credentials_uid        ON user_credentials(uid)
--   idx_credential_usage_uid        ON credential_usage(uid)
--   idx_quiz_sets_uid               ON quiz_sets(uid)
--   idx_quiz_sets_quiz_uuid         ON quiz_sets(quiz_uuid)
--   idx_quiz_submissions_uid        ON quiz_submissions(uid)
--   idx_async_tasks_uid             ON async_tasks(uid)

-- 共享数据索引
--   idx_collection_bvid             ON collection(bvid)
--   idx_video_cache_bvid            ON video_cache(bvid)
--   idx_favorite_videos_folder_id   ON favorite_videos(folder_id)
--   idx_favorite_videos_video_id    ON favorite_videos(video_id)
--   idx_video_video_id              ON video(video_id)

-- 唯一约束汇总
--   users.uid                                     PRIMARY KEY
--   user_oauth(provider, provider_uid)             UNIQUE
--   user_tokens.session_token                       PRIMARY KEY
--   user_device(uid, fingerprint)                  UNIQUE
--   user_profile.uid                               PRIMARY KEY
--   user_tag_link(uid, tag_id)                     UNIQUE
--   user_account.uid                               PRIMARY KEY
--   rbac_role_permission(role_id, permission_id)   UNIQUE
--   chat_sessions.chat_session_id                  UNIQUE
--   quiz_sets.quiz_uuid                            UNIQUE
--   quiz_submissions.submission_uuid               UNIQUE
--   async_tasks.task_id                            UNIQUE
--   favorite_folders(uid, media_id)                UNIQUE
--   favorite_videos(folder_id, video_id)           UNIQUE
--   video_cache.bvid                               UNIQUE
--   video(video_id, cid)                 UNIQUE
--   video(video_id, page_index)          UNIQUE


-- ============================================================
-- 六、软删除策略（全局统一）
-- ============================================================
--
-- 软删除实现：
--   DELETE FROM xxx WHERE id = 1
--   ↓
--   UPDATE xxx SET deleted_at = CURRENT_TIMESTAMP WHERE id = 1
--
-- 查询时统一过滤：
--   SELECT * FROM xxx WHERE deleted_at IS NULL
--
-- 带软删除字段的表（14 张）：
--   users, user_oauth, user_tokens, user_device, user_profile,
--   user_tag_link, favorite_folders, chat_sessions,
--   user_embedding_configs, user_asr_configs, user_credentials,
--   quiz_sets, video_cache, async_tasks
--
-- 不设软删除的表（12 张）：
--   user_tags, user_account, user_transaction,
--   rbac_role, rbac_permission, rbac_role_permission, rbac_user_role,
--   credential_usage, quiz_submissions,
--   favorite_videos, video


-- ============================================================
-- 七、MySQL ↔ PostgreSQL 迁移速查
-- ============================================================
--
--   MySQL                              PostgreSQL
--   ─────────────────────────────────────────────────────
--   INT AUTO_INCREMENT PRIMARY KEY     SERIAL PRIMARY KEY
--   BOOLEAN                            BOOLEAN
--   TIMESTAMP                           TIMESTAMP
--   TEXT                                TEXT
--   DECIMAL(18,4)                       DECIMAL(18,4)
--   CREATE INDEX ... ON t(col)          CREATE INDEX ... ON t(col)
--   UNIQUE (a, b)                       UNIQUE (a, b)
--   DEFAULT CURRENT_TIMESTAMP           DEFAULT CURRENT_TIMESTAMP
--   CREATE DATABASE IF NOT EXISTS       CREATE DATABASE (no IF NOT EXISTS)
--   ENGINE=InnoDB                       (no ENGINE clause)
--
--   批量替换（MySQL → PG）：
--     sed 's/INT AUTO_INCREMENT PRIMARY KEY/SERIAL PRIMARY KEY/g'
--     sed 's/`//g'
--     sed '/CHARACTER SET\|COLLATE\|ENGINE=/d'
