// Package db owns the app-board schema (CREATE TABLE IF NOT EXISTS only). The
// process-wide MySQL pool lives in internal/infra/mysql.
//
// Migration policy: matches note/quiz — CREATE-ONLY, never ALTER. The board
// table is owned by this service, but the shared mind_base database may hold
// live data, so a fresh deployment only creates what is missing.
package db

import (
	"fmt"

	"gorm.io/gorm"
)

// ownedTables is the full set of tables app-board may touch with DDL.
var ownedTables = []string{"board"}

// OwnedTables exposes the pinned table list for the schema guard test.
func OwnedTables() []string { return append([]string(nil), ownedTables...) }

// SchemaDDL exposes the CREATE TABLE statements for the schema guard test.
func SchemaDDL() []string { return append([]string(nil), schemaDDL()...) }

// Migrate creates the board schema if (and only if) it does not exist yet.
func Migrate(db *gorm.DB) error {
	for _, ddl := range schemaDDL() {
		if err := db.Exec(ddl).Error; err != nil {
			return fmt.Errorf("exec board ddl: %w", err)
		}
	}
	return nil
}

func schemaDDL() []string {
	return []string{
		`create table if not exists board (
			uuid       varchar(36) not null,
			uid        bigint      not null,
			title      varchar(255) not null default '',
			kind       varchar(16) not null,
			version    bigint      not null default 1,
			is_pinned  tinyint(1)  not null default 0,
			deleted    tinyint(1)  not null default 0,
			created_at datetime(3) null,
			updated_at datetime(3) null,
			primary key (uuid),
			index idx_board_uid_updated (uid, is_pinned, deleted),
			index idx_board_uid_kind (uid, kind)
		)`,
	}
}
