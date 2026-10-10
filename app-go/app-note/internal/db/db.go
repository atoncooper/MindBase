// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-note's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The note
// tables already exist with live data (created by the Python backend via
// db/system.sql); GORM AutoMigrate is deliberately NOT used because it
// issues ALTERs that could drift a shared, in-production schema. The DDL
// below mirrors db/system.sql verbatim. Indexes are declared inline
// (MySQL 8 has no CREATE INDEX IF NOT EXISTS).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-note/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
//
// loc=UTC (unlike app-cloud's loc=Local): the Python notes stack wrote naive
// UTC datetimes into these DATETIME columns (datetime.now(timezone.utc)), so
// parsed values must be interpreted as UTC for If-Match comparisons and
// wire-format compatibility to hold.
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

// ownedTables is the full set of tables app-note may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"notes",
	"note_anchors",
	"note_shares",
}

// Migrate creates the note schema if (and only if) it does not exist yet.
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
		`create table if not exists notes (
			id             int auto_increment primary key,
			uuid           varchar(36)  not null,
			uid            bigint       not null,
			title          varchar(500) not null default '无标题',
			target_type    varchar(20)  not null,
			target_id      varchar(100) not null,
			content_doc_id varchar(64)  not null,
			content_length int          null default 0,
			content_hash   varchar(64)  null,
			revision_count int          null default 0,
			is_pinned      tinyint(1)   null default 0,
			is_deleted     tinyint(1)   null default 0,
			created_at     datetime     null,
			updated_at     datetime     null,
			constraint uq_notes_uuid unique (uuid),
			index ix_notes_uid (uid),
			index ix_notes_target_id (target_id),
			index ix_notes_uid_target (uid, target_type, target_id),
			constraint notes_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists note_anchors (
			id         int auto_increment primary key,
			note_id    int          not null,
			block_id   varchar(50)  not null,
			position   int          not null,
			label      varchar(200) null,
			created_at datetime     null,
			index ix_note_anchors_note_id (note_id),
			constraint note_anchors_ibfk_1 foreign key (note_id) references notes (id) on delete cascade
		)`,
		`create table if not exists note_shares (
			id             int auto_increment primary key,
			note_uuid      varchar(36) not null,
			share_token    varchar(64) not null,
			created_by_uid bigint      not null,
			expires_at     datetime    null,
			view_count     int         null default 0,
			is_revoked     tinyint(1)  null default 0,
			created_at     datetime    null,
			constraint uq_note_shares_token unique (share_token),
			index ix_note_shares_note_uuid (note_uuid),
			constraint note_shares_ibfk_1 foreign key (note_uuid) references notes (uuid) on delete cascade,
			constraint note_shares_ibfk_2 foreign key (created_by_uid) references users (uid)
		)`,
	}
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=UTC.
func toGormDSN(sqlalchemyURL string) string {
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	atIdx := strings.LastIndex(s, "@")
	if atIdx < 0 {
		return s + "?charset=utf8mb4&parseTime=True&loc=UTC"
	}
	userPass := s[:atIdx]
	hostDB := s[atIdx+1:]
	slashIdx := strings.Index(hostDB, "/")
	if slashIdx < 0 {
		return userPass + "@tcp(" + hostDB + ")/?charset=utf8mb4&parseTime=True&loc=UTC"
	}
	hostPort := hostDB[:slashIdx]
	rest := hostDB[slashIdx+1:]
	if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
		rest = rest[:qIdx]
	}
	return userPass + "@tcp(" + hostPort + ")/" + rest + "?charset=utf8mb4&parseTime=True&loc=UTC"
}
