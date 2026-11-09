// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-settings's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The tables
// already exist with live data (created by the Python backend via
// Base.metadata.create_all); the DDL below mirrors app/models.py column shapes
// verbatim. The settings domain owns user_preferences and coding_plans (the
// latter migrated out of the auth domain: user configuration, not identity).
// The per-user API key config tables (user_embedding_configs / user_asr_configs
// / user_credentials) were retired together with BYOK: nothing reads them
// anymore, so the service neither migrates nor serves them (existing rows are
// left untouched).
package db

import (
	"fmt"

	"gorm.io/gorm"
)

var DB *gorm.DB

// Use binds the shared MySQL connection opened once by internal/platform/mysql.
func Use(gdb *gorm.DB) { DB = gdb }

// ownedTables is the full set of tables app-settings may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"user_preferences",
	"coding_plans",
}

// Migrate creates the config schema if (and only if) it does not exist yet.
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
		`create table if not exists user_preferences (
			uid        bigint       not null,
			pref_key   varchar(64)  not null,
			pref_value text         not null,
			created_at datetime     null,
			updated_at datetime     null,
			primary key (uid, pref_key)
		)`,
		// Coding Plan endpoints (VIP/SVIP only): moved from the auth domain.
		// FK to users(uid) is created here only because authdb.Migrate runs
		// first in main(); the table holds user configuration, not identity.
		`create table if not exists coding_plans (
			id          bigint auto_increment primary key,
			uid         bigint       not null,
			provider    varchar(32)  not null,
			protocol    varchar(16)  not null,
			label       varchar(100) null,
			base_url    varchar(500) not null,
			model       varchar(200) null,
			api_key_enc text         not null,
			enabled     tinyint(1) default 1 null,
			created_at  datetime     null,
			updated_at  datetime     null,
			index idx_cp_uid (uid),
			constraint coding_plans_ibfk_1 foreign key (uid) references users (uid)
		)`,
	}
}

// SchemaDDL exposes the CREATE-only DDL for the black-box tests package.
func SchemaDDL() []string { return schemaDDL() }

// OwnedTables exposes the table ownership list for the black-box tests package.
func OwnedTables() []string { return ownedTables }
