// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-user's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. These
// tables already exist with live data (created by the Python backend via
// db/system.sql); GORM AutoMigrate is deliberately NOT used because it
// issues ALTERs that could drift a shared, in-production schema. The video
// DDL below mirrors the LIVE schema (system.sql plus the vector_asr_version
// / kg_status / kg_version columns the Python models declare). Indexes are
// declared inline (MySQL 8 has no CREATE INDEX IF NOT EXISTS).
package db

import (
	"fmt"

	"gorm.io/gorm"
)

var DB *gorm.DB

// Use binds the shared MySQL connection opened once by internal/platform/mysql.
func Use(gdb *gorm.DB) { DB = gdb }

// ownedTables is the full set of tables app-user may touch with DDL. The
// guard test pins Migrate to exactly this list. async_tasks is OWNED here but
// also written by the Python backend (vec_page rows) — shared-table precedent
// per app-task's task_quiz_* tables; DDL ownership stays with app-user.
var ownedTables = []string{
	"collection",
	"favorite_folders",
	"video",
	"video_versions",
	"async_tasks",
}

// Migrate creates the acquisition schema if (and only if) it does not exist.
func Migrate() error {
	for _, ddl := range schemaDDL() {
		if err := DB.Exec(ddl).Error; err != nil {
			return fmt.Errorf("exec ddl: %w", err)
		}
	}
	return nil
}

func schemaDDL() []string {
	return []string{
		`create table if not exists collection (
			id          int auto_increment primary key,
			media_id    bigint       not null,
			bvid        varchar(20)  not null,
			cid         bigint       null,
			title       varchar(500) not null,
			cover       varchar(500) null,
			duration    int          null,
			owner_name  varchar(100) null,
			owner_mid   bigint       null,
			description text         null,
			created_at  datetime     null,
			updated_at  datetime     null,
			-- folder listing: where media_id = ? order by created_at desc, id desc
			index ix_collection_media_created (media_id, created_at, id),
			-- bvid usage counting (removal safety).
			index ix_collection_bvid (bvid),
			constraint uq_collection_media_bvid unique (media_id, bvid)
		)`,
		`create table if not exists favorite_folders (
			id           int auto_increment primary key,
			session_id   varchar(64)          null,
			media_id     bigint               not null,
			fid          bigint               null,
			title        varchar(200)         not null,
			media_count  int                  null,
			is_selected  tinyint(1)           null,
			last_sync_at datetime             null,
			created_at   datetime             null,
			updated_at   datetime             null,
			uid          bigint               null,
			is_default   tinyint(1) default 0 null,
			deleted_at   timestamp            null,
			index ix_favorite_folders_session_id (session_id),
			constraint uq_fav_folder_uid_media unique (uid, media_id)
		)`,
		// Mirrors the LIVE schema: system.sql plus the vector_asr_version /
		// kg_status / kg_version columns the Python models declare.
		`create table if not exists video (
			id                 int auto_increment primary key,
			bvid               varchar(20)  not null,
			cid                bigint       not null,
			page_index         int          not null,
			page_title         varchar(500) null,
			content_source     varchar(20)  null,
			is_processed       tinyint(1)   null,
			version            int          null,
			is_vectorized      varchar(20)  null,
			vectorized_at      datetime     null,
			vector_chunk_count int          null,
			vector_error       text         null,
			vector_asr_version int          null,
			kg_status          varchar(20)  null,
			kg_version         int          null,
			created_at         datetime     null,
			updated_at         datetime     null,
			index ix_video_bvid (bvid),
			constraint uq_video_bvid_cid unique (bvid, cid),
			constraint uq_video_bvid_index unique (bvid, page_index)
		)`,
		`create table if not exists video_versions (
			id             int auto_increment primary key,
			bvid           varchar(20) not null,
			cid            bigint      null,
			page_index     int         not null,
			version        int         not null,
			content_source varchar(20) null,
			is_latest      tinyint(1)  null,
			created_at     datetime    null,
			index ix_video_versions_bvid (bvid),
			constraint uq_video_version unique (bvid, cid, version)
		)`,
		`create table if not exists async_tasks (
			id           int auto_increment primary key,
			task_id      varchar(64) not null,
			task_type    varchar(20) not null,
			target       json        not null,
			status       varchar(20) null,
			progress     int         null,
			steps        json        null,
			result       json        null,
			error        text        null,
			created_at   datetime    null,
			updated_at   datetime    null,
			completed_at datetime    null,
			uid          bigint      null,
			constraint ix_async_tasks_task_id unique (task_id),
			-- live-task lookup: task_type + status, newest first (id desc).
			index ix_async_tasks_type_status_id (task_type, status, id),
			-- per-user build guard: uid + task_type + status, newest first.
			index ix_async_tasks_uid_type_status_id (uid, task_type, status, id),
			-- retention cleanup: completed_at < NOW() - INTERVAL 30 DAY.
			index ix_async_tasks_completed_at (completed_at)
		)`,
	}
}

// SchemaDDL exposes the CREATE-only DDL for the black-box tests package.
func SchemaDDL() []string { return schemaDDL() }

// OwnedTables exposes the table ownership list for the black-box tests package.
func OwnedTables() []string { return ownedTables }
