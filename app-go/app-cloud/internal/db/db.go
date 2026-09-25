// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-cloud's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The cloud
// tables already exist with live data (created by the Python backend via
// app/system.sql); GORM AutoMigrate is deliberately NOT used because it
// issues ALTERs that could drift a shared, in-production schema. The DDL
// below mirrors app/system.sql verbatim (plus the new cloud_shares table,
// owned by app-cloud from day one). Indexes are declared inline (MySQL 8 has
// no CREATE INDEX IF NOT EXISTS).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-cloud/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
func Init(dsn string, maxOpen, maxIdle, maxLife int, debug bool) error {
	gormDSN := toGormDSN(dsn)
	d, err := gorm.Open(mysql.Open(gormDSN), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := d.DB()
	if err != nil {
		return fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(time.Duration(maxLife) * time.Second)
	DB = d
	return nil
}

func Close() error {
	if DB == nil {
		return nil
	}
	sqlDB, err := DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// ownedTables is the full set of tables app-cloud may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"cloud_folders",
	"cloud_files",
	"cloud_shares",
}

// Migrate creates the cloud schema if (and only if) it does not exist yet.
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
		`create table if not exists cloud_folders (
			id         int auto_increment primary key,
			uid        bigint       not null,
			parent_id  int          null,
			name       varchar(200) not null,
			video_count int         null,
			sort_order int          null,
			created_at datetime     null,
			updated_at datetime     null,
			deleted_at datetime     null,
			index ix_cloud_folders_uid (uid),
			constraint cloud_folders_ibfk_1 foreign key (uid) references users (uid),
			constraint cloud_folders_ibfk_2 foreign key (parent_id) references cloud_folders (id)
		)`,
		`create table if not exists cloud_files (
			id                 int auto_increment primary key,
			upload_uuid        varchar(64)  not null,
			uid                bigint       not null,
			folder_id          int          null,
			original_name      varchar(500) not null,
			file_size          bigint       not null,
			mime_type          varchar(128) not null,
			duration           int          null,
			bucket             varchar(64)  not null,
			object_key         varchar(500) not null,
			etag               varchar(64)  null,
			upload_status      varchar(20)  null,
			asr_status         varchar(20)  null,
			vector_status      varchar(20)  null,
			vector_chunk_count int          null,
			title              varchar(500) null,
			description        text         null,
			cover_url          varchar(500) null,
			tags               json         null,
			vectorizable       tinyint(1)   not null default 1,
			doc_parser         varchar(20)  null,
			doc_meta           json         null,
			content_hash       varchar(128) null,
			created_at         datetime     null,
			updated_at         datetime     null,
			deleted_at         datetime     null,
			index ix_cloud_files_uid (uid),
			index ix_cloud_files_upload_uuid (upload_uuid),
			constraint uq_cloud_files_uuid unique (upload_uuid),
			constraint cloud_files_ibfk_1 foreign key (uid) references users (uid),
			constraint cloud_files_ibfk_2 foreign key (folder_id) references cloud_folders (id)
		)`,
		// New table — app-cloud owned from day one (Baidu-style shares).
		`create table if not exists cloud_shares (
			id             int auto_increment primary key,
			share_token    varchar(64) not null,
			uid            bigint      not null,
			file_id        int         not null,
			extraction_code varchar(64) null,
			expires_at     datetime    null,
			max_downloads  int         null,
			view_count     int         not null default 0,
			download_count int         not null default 0,
			is_revoked     tinyint(1)  not null default 0,
			created_at     datetime    null,
			updated_at     datetime    null,
			index idx_cloud_shares_uid (uid),
			index idx_cloud_shares_file (file_id),
			constraint uq_cloud_shares_token unique (share_token)
		)`,
	}
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=Local.
func toGormDSN(sqlalchemyURL string) string {
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	atIdx := strings.LastIndex(s, "@")
	if atIdx < 0 {
		return s + "?charset=utf8mb4&parseTime=True&loc=Local"
	}
	userPass := s[:atIdx]
	hostDB := s[atIdx+1:]
	slashIdx := strings.Index(hostDB, "/")
	if slashIdx < 0 {
		return userPass + "@tcp(" + hostDB + ")/?charset=utf8mb4&parseTime=True&loc=Local"
	}
	hostPort := hostDB[:slashIdx]
	rest := hostDB[slashIdx+1:]
	if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
		rest = rest[:qIdx]
	}
	return userPass + "@tcp(" + hostPort + ")/" + rest + "?charset=utf8mb4&parseTime=True&loc=Local"
}
