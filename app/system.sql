-- ============================================================
-- Bilibili RAG 知识库系统 — 数据库设计文档
-- ============================================================
-- 本文件涵盖后端全部数据存储层设计：
--   1. SQLite 关系型数据库（结构化数据）
--   2. ChromaDB 向量数据库（语义检索）
-- ============================================================

-- ============================================================
-- 一、SQLite 关系型数据库
-- ============================================================

-- -----------------------------------------------------------
-- 1. video_cache — 视频内容缓存表
-- -----------------------------------------------------------
CREATE TABLE video_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid            VARCHAR(20)  NOT NULL UNIQUE,
    cid             INTEGER,
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    owner_name      VARCHAR(100),
    owner_mid       INTEGER,
    content         TEXT,                       -- 摘要 / 字幕文本
    content_source  VARCHAR(20),                -- ai_summary / subtitle / basic_info
    outline_json    TEXT,                       -- 分段提纲（JSON）
    duration        INTEGER,                    -- 视频时长（秒）
    pic_url         VARCHAR(500),               -- 封面URL
    is_processed    INTEGER DEFAULT 0,          -- 是否已处理并加入向量库
    process_error   TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_video_cache_bvid ON video_cache(bvid);

-- -----------------------------------------------------------
-- 2. user_sessions — 用户会话表
-- -----------------------------------------------------------
CREATE TABLE user_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      VARCHAR(64)  NOT NULL UNIQUE,
    bili_mid        INTEGER,                    -- B站用户ID
    bili_uname      VARCHAR(100),               -- B站用户名
    bili_face       VARCHAR(500),               -- 头像URL
    sessdata        TEXT,                       -- Cookie（建议加密存储）
    bili_jct        TEXT,
    dedeuserid      VARCHAR(50),
    is_valid        INTEGER DEFAULT 1,
    last_active_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_sessions_session_id ON user_sessions(session_id);

-- -----------------------------------------------------------
-- 3. favorite_folders — 收藏夹记录表
-- -----------------------------------------------------------
CREATE TABLE favorite_folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      VARCHAR(64)  NOT NULL,
    media_id        INTEGER      NOT NULL,      -- 收藏夹ID
    fid             INTEGER,                    -- 原始ID
    title           VARCHAR(200) NOT NULL,
    media_count     INTEGER DEFAULT 0,          -- 视频数量
    is_selected     INTEGER DEFAULT 1,          -- 是否选中用于知识库
    last_sync_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_favorite_folders_session_id ON favorite_folders(session_id);

-- -----------------------------------------------------------
-- 4. favorite_videos — 收藏夹-视频关联表
-- -----------------------------------------------------------
CREATE TABLE favorite_videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER      NOT NULL,      -- 关联 favorite_folders.id
    bvid            VARCHAR(20)  NOT NULL,
    is_selected     INTEGER DEFAULT 1,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_favorite_videos_folder_id ON favorite_videos(folder_id);
CREATE INDEX idx_favorite_videos_bvid      ON favorite_videos(bvid);

-- -----------------------------------------------------------
-- 5. video_pages — 视频分P信息表
-- -----------------------------------------------------------
CREATE TABLE video_pages (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid                 VARCHAR(20)  NOT NULL,
    cid                  INTEGER      NOT NULL,  -- B站唯一标识
    page_index           INTEGER      NOT NULL,  -- 0-based P序号
    page_title           VARCHAR(500),           -- 如 "P1. 引言"
    content              TEXT,                   -- ASR 转写文字（当前最新版本）
    content_source       VARCHAR(20),            -- asr / user_edit
    is_processed         INTEGER DEFAULT 0,      -- ASR 是否完成
    version              INTEGER DEFAULT 1,      -- 当前版本号
    is_vectorized        VARCHAR(20) DEFAULT 'pending',  -- pending / processing / done / failed
    vectorized_at        TIMESTAMP,
    vector_chunk_count   INTEGER DEFAULT 0,
    vector_error         TEXT,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (bvid, cid),
    UNIQUE (bvid, page_index)
);

CREATE INDEX idx_video_pages_bvid ON video_pages(bvid);

-- -----------------------------------------------------------
-- 6. video_page_versions — 分P ASR 版本历史表
-- -----------------------------------------------------------
CREATE TABLE video_page_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid            VARCHAR(20)  NOT NULL,
    cid             INTEGER      NOT NULL,
    page_index      INTEGER      NOT NULL,
    version         INTEGER      NOT NULL,
    content         TEXT,
    content_source  VARCHAR(20),                -- asr / user_edit
    is_latest       INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (bvid, cid, version)
);

CREATE INDEX idx_video_page_versions_bvid ON video_page_versions(bvid);

-- -----------------------------------------------------------
-- 7. async_tasks — 通用异步任务表
-- -----------------------------------------------------------
CREATE TABLE async_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         VARCHAR(64)  NOT NULL UNIQUE,
    task_type       VARCHAR(20)  NOT NULL,      -- vec_page / asr / ...
    target          TEXT         NOT NULL,       -- JSON: {"bvid":"BV1xx","cid":123,...}
    status          VARCHAR(20) DEFAULT 'pending',
    progress        INTEGER DEFAULT 0,
    steps           TEXT,                        -- JSON: 子步骤进度
    result          TEXT,                        -- JSON
    error           TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP
);

CREATE INDEX idx_async_tasks_task_id ON async_tasks(task_id);

-- -----------------------------------------------------------
-- 8. chat_sessions — 聊天会话表
-- -----------------------------------------------------------
CREATE TABLE chat_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_session_id VARCHAR(64)  NOT NULL UNIQUE,
    session_id      VARCHAR(64)  NOT NULL,      -- 登录态 session
    title           VARCHAR(200),
    status          VARCHAR(20) DEFAULT 'active',  -- active / archived / deleted
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP
);

CREATE INDEX idx_chat_sessions_chat_session_id ON chat_sessions(chat_session_id);
CREATE INDEX idx_chat_sessions_session_id      ON chat_sessions(session_id);

-- -----------------------------------------------------------
-- 9. chat_messages — 聊天消息表
-- -----------------------------------------------------------
CREATE TABLE chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_session_id VARCHAR(64)  NOT NULL,
    role            VARCHAR(20)  NOT NULL,      -- user / assistant / system
    content         TEXT         NOT NULL DEFAULT '',
    status          VARCHAR(20) DEFAULT 'completed',  -- pending / completed / failed
    sources         TEXT,                        -- JSON: 来源列表
    tokens_used     INTEGER,
    model           VARCHAR(100),
    latency_ms      INTEGER,
    error           TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_messages_chat_session_id ON chat_messages(chat_session_id);

-- -----------------------------------------------------------
-- 10. user_settings — 用户自定义 API Key 配置表
-- -----------------------------------------------------------
CREATE TABLE user_settings (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id                  VARCHAR(64)  NOT NULL UNIQUE,
    llm_api_key_encrypted       TEXT,           -- LLM Key 密文
    llm_base_url                TEXT,
    llm_model                   TEXT,
    embedding_api_key_encrypted TEXT,           -- Embedding Key 密文
    embedding_base_url          TEXT,
    embedding_model             TEXT,
    asr_api_key_encrypted       TEXT,           -- ASR Key 密文
    asr_base_url                TEXT,
    asr_model                   TEXT,
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_settings_session_id ON user_settings(session_id);

-- -----------------------------------------------------------
-- 11. user_credentials — 用户多 Provider API Key 配置表
-- -----------------------------------------------------------
CREATE TABLE user_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      VARCHAR(64)  NOT NULL,
    name            VARCHAR(64)  NOT NULL,      -- 用户自定义名称
    provider        VARCHAR(32)  NOT NULL,      -- openai / anthropic / deepseek / custom
    api_key_encrypted TEXT       NOT NULL,      -- Key 密文
    base_url        TEXT,
    default_model   TEXT,
    is_default      INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_credentials_session_id ON user_credentials(session_id);

-- -----------------------------------------------------------
-- 12. credential_usage — 凭证用量记录表
-- -----------------------------------------------------------
CREATE TABLE credential_usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          VARCHAR(64)  NOT NULL,
    credential_id       INTEGER,                -- NULL = 系统默认 Key
    provider            VARCHAR(32),
    model               VARCHAR(64),
    prompt_tokens       INTEGER DEFAULT 0,
    completion_tokens   INTEGER DEFAULT 0,
    total_tokens        INTEGER DEFAULT 0,
    api_calls           INTEGER DEFAULT 1,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_credential_usage_session_id ON credential_usage(session_id);

-- -----------------------------------------------------------
-- 13. quiz_sets — 题目集
-- -----------------------------------------------------------
CREATE TABLE quiz_sets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_uuid           VARCHAR(64)  NOT NULL UNIQUE,
    session_id          VARCHAR(64)  NOT NULL,
    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    question_count      INTEGER DEFAULT 10,
    type_distribution   TEXT,                   -- JSON: {"single_choice":3,...}
    difficulty          VARCHAR(20) DEFAULT 'medium',
    folder_ids          TEXT,                   -- JSON: [1, 2, 3]
    source_type         VARCHAR(20) DEFAULT 'folder',  -- folder / pages
    source_pages        TEXT,                   -- JSON: [{"bvid":"BVxxx","cid":123,...}]
    bvid_count          INTEGER DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'generating',
    error_message       TEXT,
    total_score         INTEGER DEFAULT 100,
    passing_score       INTEGER DEFAULT 60,
    completed_at        TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_quiz_sets_quiz_uuid  ON quiz_sets(quiz_uuid);
CREATE INDEX idx_quiz_sets_session_id ON quiz_sets(session_id);

-- -----------------------------------------------------------
-- 14. quiz_questions — 题目明细
-- -----------------------------------------------------------
CREATE TABLE quiz_questions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_uuid           VARCHAR(64)  NOT NULL,
    question_uuid       VARCHAR(64)  NOT NULL UNIQUE,
    bvid                VARCHAR(20),
    chunk_id            VARCHAR(20),
    source_segment      TEXT,
    question_type       VARCHAR(20)  NOT NULL,  -- single_choice / multi_choice / short_answer / essay
    difficulty          VARCHAR(20) DEFAULT 'medium',
    question_text       TEXT         NOT NULL,
    options             TEXT,                   -- JSON: ["A. 选项1", ...]
    correct_answer      TEXT         NOT NULL,   -- "A" / ["A","C"] / "答案文本"
    explanation         TEXT,
    keywords            TEXT,                   -- JSON: ["关键词1", ...]
    answer_template     TEXT,
    scoring_rubric      TEXT,                   -- JSON
    model_answer        TEXT,
    metadata_extra      TEXT,                   -- JSON
    is_valid            INTEGER DEFAULT 1,
    invalid_reason      TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_quiz_questions_quiz_uuid      ON quiz_questions(quiz_uuid);
CREATE INDEX idx_quiz_questions_question_uuid  ON quiz_questions(question_uuid);

-- -----------------------------------------------------------
-- 15. quiz_submissions — 提交记录
-- -----------------------------------------------------------
CREATE TABLE quiz_submissions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_uuid         VARCHAR(64)  NOT NULL UNIQUE,
    quiz_uuid               VARCHAR(64)  NOT NULL,
    session_id              VARCHAR(64)  NOT NULL,
    total_score             INTEGER,
    auto_score              INTEGER,
    manual_score            INTEGER,
    passing_score           INTEGER,
    is_complete             INTEGER DEFAULT 0,
    is_passed               INTEGER,
    correct_count           INTEGER DEFAULT 0,
    total_question_count    INTEGER DEFAULT 0,
    time_spent_seconds      INTEGER,
    started_at              TIMESTAMP,
    submitted_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    graded_at               TIMESTAMP
);

CREATE INDEX idx_quiz_submissions_quiz_uuid   ON quiz_submissions(quiz_uuid);
CREATE INDEX idx_quiz_submissions_session_id  ON quiz_submissions(session_id);

-- -----------------------------------------------------------
-- 16. quiz_answers — 答案明细
-- -----------------------------------------------------------
CREATE TABLE quiz_answers (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_uuid         VARCHAR(64)  NOT NULL,
    question_uuid           VARCHAR(64)  NOT NULL,
    question_type           VARCHAR(20)  NOT NULL,
    user_answer             TEXT         NOT NULL,   -- JSON
    user_answer_text        TEXT,
    is_correct              INTEGER,
    auto_score              INTEGER,
    manual_score            INTEGER,
    final_score             INTEGER,
    correct_answer_snapshot TEXT         NOT NULL,   -- JSON
    matched_keywords        TEXT,                   -- JSON
    keyword_match_rate      REAL,
    grading_detail          TEXT,                   -- JSON
    submitted_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    graded_at               TIMESTAMP
);

CREATE INDEX idx_quiz_answers_submission_uuid ON quiz_answers(submission_uuid);
CREATE INDEX idx_quiz_answers_question_uuid   ON quiz_answers(question_uuid);


-- ============================================================
-- 二、ChromaDB 向量数据库
-- ============================================================
-- Collection: bilibili_videos
-- 存储方式: LangChain Chroma (持久化目录: data/chroma/)
-- 嵌入模型: OpenAI / DashScope (text-embedding-3-small 等)
-- ============================================================

-- -----------------------------------------------------------
-- Collection Schema: bilibili_videos
-- -----------------------------------------------------------
-- 字段说明：
--   ids          : chunk_id = "{bvid}:{page_index}:{chunk_index}"
--   documents    : 文本块（含标题前缀，用于 embedding + LLM 上下文）
--   embeddings   : 向量（由 embedding_model 生成）
--   metadatas    : 结构化元数据（见下）
--
-- Metadata 结构：
--   {
--     "bvid":             "BV1xxxxx",        -- 视频ID
--     "title":            "视频标题",
--     "page_index":       0,                 -- 分P序号（0-based）
--     "page_title":       "P1. 引言",        -- 分P标题
--     "source":           "asr",             -- 内容来源: ai_summary / subtitle / asr / basic_info
--     "chunk_index":      0,                 -- 块序号
--     "chunk_id":         "BV1xx:0:0",       -- 唯一块ID
--     "section_title":    "章节标题",
--     "content_type":     "正文",            -- 内容类型标记
--     "embedding_version":"v1",             -- 嵌入版本号
--     "url":              "https://www.bilibili.com/video/BV1xxxxx?p=1"
--   }
--
-- 过滤条件支持：
--   - where={"bvid": "BV1xxxxx"}              精确匹配视频
--   - where={"bvid": {"$in": ["BV1a", "BV1b"]}} 批量视频过滤
--   - where={"page_index": 0}                 精确匹配分P
--   - where={"source": "asr"}                 按来源过滤
--
-- 检索接口：
--   - similarity_search(query, k=5, filter=filter_cond)
--   - 返回 Document 列表（page_content + metadata）
--
-- 写入接口：
--   - add_documents(documents)  批量写入（batch_size=10）
--
-- 删除接口：
--   - 先按 bvid 查询全部 chunk_id，再按 page_index 过滤，最后 delete(ids)
--
-- 重建注意事项：
--   - 更换 embedding_model 后必须清空全量重建（向量空间不兼容）
--   - embedding_version 字段用于追踪模型版本


-- ============================================================
-- 三、数据流转关系
-- ============================================================
--
-- 用户登录:
--   user_sessions (sessdata / bili_jct)
--       |
--       v
-- 收藏夹同步:
--   favorite_folders  <--session_id-->  favorite_videos  <--bvid-->  video_cache
--       |
--       v
-- ASR 处理:
--   video_cache (is_processed)  -->  video_pages (content, content_source)
--       |
--       v
-- 向量化:
--   video_pages (is_vectorized)  -->  ChromaDB (bilibili_videos collection)
--       |
--       v
-- 问答:
--   ChromaDB (similarity_search)  -->  chat_messages (sources 字段记录召回结果)
--
-- 版本管理:
--   video_pages (version)  <--  video_page_versions (历史版本)
--
-- 任务队列:
--   async_tasks (task_type=vec_page/asr, status, steps, progress)
--
-- 计费:
--   credential_usage  <--credential_id-->  user_credentials / user_settings
--
-- Quiz 训练:
--   quiz_sets  <--quiz_uuid-->  quiz_questions
--       |
--       v
--   quiz_submissions  <--submission_uuid-->  quiz_answers


-- ============================================================
-- 四、索引汇总
-- ============================================================
-- SQLite 索引：
--   idx_video_cache_bvid              ON video_cache(bvid)
--   idx_user_sessions_session_id      ON user_sessions(session_id)
--   idx_favorite_folders_session_id   ON favorite_folders(session_id)
--   idx_favorite_videos_folder_id     ON favorite_videos(folder_id)
--   idx_favorite_videos_bvid          ON favorite_videos(bvid)
--   idx_video_pages_bvid              ON video_pages(bvid)
--   idx_video_page_versions_bvid      ON video_page_versions(bvid)
--   idx_async_tasks_task_id           ON async_tasks(task_id)
--   idx_chat_sessions_chat_session_id ON chat_sessions(chat_session_id)
--   idx_chat_sessions_session_id      ON chat_sessions(session_id)
--   idx_chat_messages_chat_session_id ON chat_messages(chat_session_id)
--   idx_user_settings_session_id      ON user_settings(session_id)
--   idx_user_credentials_session_id   ON user_credentials(session_id)
--   idx_credential_usage_session_id   ON credential_usage(session_id)
--   idx_quiz_sets_quiz_uuid           ON quiz_sets(quiz_uuid)
--   idx_quiz_sets_session_id          ON quiz_sets(session_id)
--   idx_quiz_questions_quiz_uuid      ON quiz_questions(quiz_uuid)
--   idx_quiz_questions_question_uuid  ON quiz_questions(question_uuid)
--   idx_quiz_submissions_quiz_uuid    ON quiz_submissions(quiz_uuid)
--   idx_quiz_submissions_session_id   ON quiz_submissions(session_id)
--   idx_quiz_answers_submission_uuid  ON quiz_answers(submission_uuid)
--   idx_quiz_answers_question_uuid    ON quiz_answers(question_uuid)
--
-- 唯一约束：
--   video_cache.bvid                  UNIQUE
--   user_sessions.session_id          UNIQUE
--   video_pages(bvid, cid)            UNIQUE
--   video_pages(bvid, page_index)     UNIQUE
--   video_page_versions(bvid, cid, version)  UNIQUE
--   async_tasks.task_id               UNIQUE
--   chat_sessions.chat_session_id     UNIQUE
--   user_settings.session_id          UNIQUE
--   quiz_sets.quiz_uuid               UNIQUE
--   quiz_questions.question_uuid      UNIQUE
--   quiz_submissions.submission_uuid  UNIQUE
