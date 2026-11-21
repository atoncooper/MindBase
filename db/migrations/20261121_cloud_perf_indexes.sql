-- Cloud drive high-concurrency read indexes.
-- Apply once to live databases (fresh deployments already get these from
-- db/system.sql / app-cloud internal/infra/db schema DDL).
--
-- List page:
--   WHERE uid=? AND deleted_at IS NULL AND folder_id [= ?|IS NULL]
--   ORDER BY created_at DESC, id DESC
-- Trash page:
--   WHERE uid=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC

ALTER TABLE cloud_folders
    ADD INDEX ix_cloud_folders_uid_deleted (uid, deleted_at);

ALTER TABLE cloud_files
    ADD INDEX ix_cloud_files_uid_deleted_folder_created
        (uid, deleted_at, folder_id, created_at, id);

ALTER TABLE cloud_files
    ADD INDEX ix_cloud_files_uid_deleted (uid, deleted_at);
