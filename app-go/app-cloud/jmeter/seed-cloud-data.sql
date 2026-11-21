-- Cloud JMeter read-test seed data.
-- Test-only: creates users 10001..10100, one folder + 100 active files each,
-- plus 10 soft-deleted files per user for the trash read path.
-- DOES NOT create real MinIO objects: list/detail/trash read paths only.

SET SESSION cte_max_recursion_depth = 100000;
SET @seed_base = 10001;
SET @seed_users = 100;
SET @seed_files = 100;
SET @seed_trash = 10;

START TRANSACTION;

DELETE FROM mind_base.cloud_files
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1;

DELETE FROM mind_base.cloud_folders
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1;

INSERT INTO mind_base.users (uid, status, created_at, updated_at)
WITH RECURSIVE seq(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < @seed_users - 1
)
SELECT @seed_base + n, 'active', NOW(), NOW()
FROM seq
ON DUPLICATE KEY UPDATE status = 'active', updated_at = NOW();

INSERT INTO mind_base.cloud_folders
  (uid, parent_id, name, video_count, sort_order, created_at, updated_at)
WITH RECURSIVE seq(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < @seed_users - 1
)
SELECT @seed_base + n,
       NULL,
       CONCAT('perf-folder-', n + 1),
       @seed_files,
       n,
       NOW(),
       NOW()
FROM seq;

INSERT INTO mind_base.cloud_files
  (upload_uuid, uid, folder_id, original_name, file_size, mime_type,
   bucket, object_key, upload_status, created_at, updated_at)
WITH RECURSIVE seq(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < @seed_users * @seed_files - 1
)
SELECT UUID(),
       @seed_base + MOD(n, @seed_users),
       NULL,
       CONCAT('perf-', n + 1, '.mp4'),
       10485760,
       'video/mp4',
       'drive-videos',
       CONCAT('seed/', UUID(), '/file.mp4'),
       'completed',
       DATE_SUB(NOW(), INTERVAL n MINUTE),
       NOW()
FROM seq;

INSERT INTO mind_base.cloud_files
  (upload_uuid, uid, folder_id, original_name, file_size, mime_type,
   bucket, object_key, upload_status, created_at, updated_at, deleted_at)
WITH RECURSIVE seq(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < @seed_users * @seed_trash - 1
)
SELECT UUID(),
       @seed_base + MOD(n, @seed_users),
       NULL,
       CONCAT('trash-', n + 1, '.mp4'),
       1048576,
       'video/mp4',
       'drive-videos',
       CONCAT('seed/', UUID(), '/file.mp4'),
       'completed',
       DATE_SUB(NOW(), INTERVAL n HOUR),
       NOW(),
       NOW()
FROM seq;

COMMIT;

SELECT COUNT(*) AS seed_users FROM mind_base.users
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1;
SELECT COUNT(*) AS active_files FROM mind_base.cloud_files
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1 AND deleted_at IS NULL;
SELECT COUNT(*) AS trash_files FROM mind_base.cloud_files
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1 AND deleted_at IS NOT NULL;
SELECT COUNT(*) AS seed_folders FROM mind_base.cloud_folders
 WHERE uid BETWEEN @seed_base AND @seed_base + @seed_users - 1;