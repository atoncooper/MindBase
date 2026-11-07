-- =============================================================================
-- 20261107_user_perf_indexes — 用户域查询索引补齐（app-user: bili + auth）
-- =============================================================================
--
-- 背景：app-user 的 bili 域与 auth 域（共享 bilirag 库）在以下热点查询上缺少
-- 可用的复合索引，列表/轮询/校验路径会退化为大范围扫描或 filesort：
--   * async_tasks：按 (task_type, status) 找最新 task（live/进行中判定），
--                  按 (uid, task_type, status) 找用户当前 build。
--   * collection  ：收藏夹分页列表 WHERE media_id = ? ORDER BY created_at DESC, id DESC；
--                  bvid 引用计数（删除前判断是否还有引用）。
--   * verification_codes：(purpose, code) 校验、(target, purpose) 取最新验证码。
--   * user_tokens ：按 expires_at 清理过期会话 / 扫描有效 token。
--   * rbac_user_role：唯一授予行 (uid, role_id)。
--
-- ⚠️ 执行注意：
--   1. 这是【共享库】（app-user / app-ts / 旧 Python 栈同库读写），索引变更属于
--      DDL，会持有元数据锁；请务必在【低峰期】执行，并逐条观察，不要并发跑
--      其他重查询 / 大批量写入（尤其 collection 的同步写入）。
--   2. system.sql 已把同样的索引写进对应 create table 定义（全新库无需执行本
--      文件）；本文件只用于【已存在的线上库】补齐索引。
--   3. MySQL 8 没有 CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS，重复执行
--      会报 "Duplicate key name"，属预期：看到该错误说明对应索引已存在，跳过即可。
--   4. rbac_user_role 的唯一索引 (uid, role_id) 必须先按 (uid, role_id) 去重，
--      否则 ALTER 会以 "Duplicate entry" 失败（第 5 组注释里的探查/去重 SQL）。
--
-- 建议执行顺序：按本文件从上到下；每组独立提交，失败不阻塞其他组（bili 组优先）。
-- =============================================================================

-- ── 1. async_tasks ──────────────────────────────────────────────────────────
-- bili/asr：findLiveTaskForPage 的 WHERE task_type='asr' AND status IN
-- ('pending','processing') ORDER BY id DESC LIMIT 50 完全走第 1 个索引；
-- build：WHERE uid=? AND task_type='build' AND status IN (...) ORDER BY id DESC
-- 走第 2 个索引。
ALTER TABLE async_tasks
    ADD INDEX ix_async_tasks_type_status_id (task_type, status, id),
    ADD INDEX ix_async_tasks_uid_type_status_id (uid, task_type, status, id),
    ADD INDEX ix_async_tasks_completed_at (completed_at);

-- ── 2. collection ───────────────────────────────────────────────────────────
-- 收藏夹分页：WHERE media_id=? ORDER BY created_at DESC, id DESC
-- （排序键进索引，去掉 filesort；id 作为稳定次序的 tie-breaker）。
ALTER TABLE collection
    ADD INDEX ix_collection_media_created (media_id, created_at, id),
    ADD INDEX ix_collection_bvid (bvid);

-- 旧单列索引 ix_collection_media_id 已被 (media_id, created_at, id) 的最左前缀
-- 覆盖；同步写入量大（收藏夹全量替换），保留只是额外的写放大，确认后可在低峰删除：
-- ALTER TABLE collection DROP INDEX ix_collection_media_id;

-- ── 3. verification_codes ───────────────────────────────────────────────────
-- 校验码核验：WHERE purpose=? AND code=?；取最新码：
-- WHERE target=? AND purpose=? ORDER BY created_at DESC。
ALTER TABLE verification_codes
    ADD INDEX ix_vc_purpose_code (purpose, code),
    ADD INDEX ix_vc_target_purpose_created (target, purpose, created_at),
    ADD INDEX ix_vc_expires_at (expires_at);

-- 旧 idx_vc_target_purpose (target, purpose) 被第 2 个索引最左前缀覆盖，可删：
-- ALTER TABLE verification_codes DROP INDEX idx_vc_target_purpose;

-- ── 4. user_tokens ──────────────────────────────────────────────────────────
-- 过期会话清理 / 有效 token 扫描：WHERE expires_at < NOW() / > NOW()。
ALTER TABLE user_tokens
    ADD INDEX ix_user_tokens_expires_at (expires_at);

-- 保留清理按 created_at 全表扫描，单独补一个索引（login_attempts 的现有索引
-- 都以 ip/email/uid 为前缀，无法服务 WHERE created_at < ...）。
ALTER TABLE login_attempts
    ADD INDEX ix_la_created_at (created_at);

-- ── 5. rbac_user_role：先按 (uid, role_id) 去重，再加唯一索引 ────────────────
-- ① 探查重复（返回空集才可继续）：
--    SELECT uid, role_id, COUNT(*) AS n
--      FROM rbac_user_role
--     GROUP BY uid, role_id
--    HAVING n > 1;
-- ② 去重：每对 (uid, role_id) 只保留 id 最小的一行（其余视为重复授予）。
--    建议先备份：CREATE TABLE rbac_user_role_bak_20261107 AS SELECT * FROM rbac_user_role;
--    DELETE r FROM rbac_user_role r
--      JOIN (
--        SELECT uid, role_id, MIN(id) AS keep_id
--          FROM rbac_user_role
--         GROUP BY uid, role_id
--      ) k ON k.uid = r.uid AND k.role_id = r.role_id
--     WHERE r.id <> k.keep_id;
-- ③ 再加唯一索引（该索引同时满足 uid 上的外键索引需求）。
-- ⚠️ 若线上已存在同义唯一索引，直接跳过本组。
ALTER TABLE rbac_user_role
    ADD UNIQUE INDEX uq_rbac_user_role_uid_role (uid, role_id);
