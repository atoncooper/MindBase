// Package db owns the app-note schema (CREATE TABLE IF NOT EXISTS only). The
// process-wide MySQL pool lives in internal/infra/mysql.
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

	"gorm.io/gorm"
)

// ownedTables is the full set of tables app-note may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"notes",
	"note_anchors",
	"note_shares",
}

// Migrate creates the note schema if (and only if) it does not exist yet.
func Migrate(db *gorm.DB) error {
	for _, ddl := range schemaDDL() {
		if err := db.Exec(ddl).Error; err != nil {
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

// SchemaDDL returns a copy of the CREATE-only statements Migrate executes.
// Exposed for schema guard tests and operational introspection.
func SchemaDDL() []string { return append([]string(nil), schemaDDL()...) }

// OwnedTables returns a copy of the tables this package owns (app-note).
func OwnedTables() []string { return append([]string(nil), ownedTables...) }
