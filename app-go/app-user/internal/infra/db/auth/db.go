// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-user's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The auth
// tables already exist with live data (created by the Python backend via
// db/system.sql); GORM AutoMigrate is deliberately NOT used because it
// issues ALTERs that could drift a shared, in-production schema. The DDL
// below mirrors db/system.sql verbatim and only fires on a fresh database.
// Indexes are declared inline (MySQL 8 has no CREATE INDEX IF NOT EXISTS).
package db

import (
	"fmt"

	"gorm.io/gorm"
)

var DB *gorm.DB

// Use binds the shared MySQL connection opened once by internal/platform/mysql.
func Use(gdb *gorm.DB) { DB = gdb }

// ownedTables is the full set of tables app-user may touch with DDL. The
// guard test pins Migrate to exactly this list — extending it requires
// updating both together.
var ownedTables = []string{
	"users",
	"rbac_role",
	"rbac_user_role",
	"user_oauth",
	"user_profile",
	"user_tokens",
	"user_device",
	"verification_codes",
	"login_attempts",
	"user_password_history",
	"user_security_events",
}

// Migrate creates the auth schema if (and only if) it does not exist yet.
// Mirrors db/system.sql DDL — keep in sync when the Python DDL changes.
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
		`create table if not exists users (
			uid            bigint auto_increment primary key,
			status         varchar(20)          null,
			created_at     datetime             null,
			updated_at     datetime             null,
			deleted_at     datetime             null,
			email          varchar(200)         null,
			phone          varchar(20)          null,
			password_hash  varchar(255)         null,
			email_verified tinyint(1) default 0 null,
			phone_verified tinyint(1) default 0 null,
			constraint email unique (email),
			constraint phone unique (phone)
		)`,
		`create table if not exists rbac_role (
			role_id     varchar(64) not null primary key,
			name        varchar(50) not null,
			description text        null,
			is_system   tinyint(1)  null,
			created_at  datetime    null,
			updated_at  datetime    null
		)`,
		`create table if not exists rbac_user_role (
			id         int auto_increment primary key,
			uid        bigint      not null,
			role_id    varchar(64) not null,
			granted_by bigint      null,
			granted_at datetime    null,
			expires_at datetime    null,
			is_active  tinyint(1)  null,
			created_at datetime    null,
			index idx_ar_uid (uid),
			index idx_arb_role (role_id),
			constraint uq_rbac_uid_role unique (uid, role_id),
			constraint rbac_user_role_ibfk_1 foreign key (uid) references users (uid),
			constraint rbac_user_role_ibfk_2 foreign key (role_id) references rbac_role (role_id)
		)`,
		`create table if not exists user_oauth (
			id            int auto_increment primary key,
			uid           bigint       not null,
			provider      varchar(32)  not null,
			provider_uid  varchar(64)  not null,
			union_id      varchar(64)  null,
			access_token  text         null,
			refresh_token text         null,
			expires_at    datetime     null,
			raw_data      text         null,
			is_primary    tinyint(1)   null,
			created_at    datetime     null,
			updated_at    datetime     null,
			deleted_at    datetime     null,
			email         varchar(200) null,
			index idx_ao_uid (uid),
			constraint uq_user_oauth_provider_uid unique (provider, provider_uid),
			constraint user_oauth_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists user_profile (
			uid        bigint       not null primary key,
			nickname   varchar(100) null,
			avatar     varchar(500) null,
			bio        text         null,
			birthday   date         null,
			gender     varchar(10)  null,
			location   varchar(100) null,
			timezone   varchar(50)  null,
			language   varchar(20)  null,
			created_at datetime     null,
			updated_at datetime     null,
			deleted_at datetime     null,
			constraint user_profile_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists user_tokens (
			session_token  varchar(128) not null primary key,
			uid            bigint       not null,
			device_id      varchar(64)  null,
			token_type     varchar(20)  null,
			expires_at     datetime     null,
			ip             varchar(64)  null,
			user_agent     text         null,
			is_revoked     tinyint(1)   null,
			last_active_at datetime     null,
			created_at     datetime     null,
			deleted_at     datetime     null,
			index idx_at_uid (uid),
			index idx_ut_expires (expires_at),
			constraint user_tokens_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists user_device (
			device_id       varchar(64)  not null primary key,
			uid             bigint       not null,
			device_type     varchar(20)  null,
			device_name     varchar(100) null,
			os              varchar(50)  null,
			os_version      varchar(50)  null,
			browser         varchar(100) null,
			browser_version varchar(50)  null,
			fingerprint     varchar(128) null,
			trust_level     varchar(20)  null,
			last_active_at  datetime     null,
			created_at      datetime     null,
			deleted_at      datetime     null,
			index idx_user_device_uid (uid),
			constraint uq_user_device_uid_fingerprint unique (uid, fingerprint),
			constraint user_device_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists verification_codes (
			id         int auto_increment primary key,
			uid        bigint       null,
			target     varchar(200) not null,
			type       varchar(20)  not null,
			purpose    varchar(32)  not null,
			code       varchar(64)  not null,
			expires_at datetime     not null,
			used       tinyint(1)   null,
			attempts   int default 0 null,
			created_at datetime     null,
			index idx_vc_target_purpose (target, purpose),
			index idx_vc_purpose_code (purpose, code),
			index idx_vc_target_purpose_created (target, purpose, created_at),
			index idx_vc_expires_at (expires_at),
			index idx_vc_uid (uid),
			constraint verification_codes_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists login_attempts (
			id             int auto_increment primary key,
			uid            bigint       null,
			email          varchar(200) null,
			ip             varchar(64)  not null,
			device_id      varchar(64)  null,
			success        tinyint(1) default 0 not null,
			failure_reason varchar(100) null,
			created_at     datetime     not null,
			index idx_la_ip_created (ip, created_at),
			index idx_la_email_created (email, created_at),
			index idx_la_uid_created (uid, created_at),
			index idx_la_created_at (created_at)
		)`,
		`create table if not exists user_password_history (
			id            bigint auto_increment primary key,
			uid           bigint       not null,
			password_hash varchar(255) not null,
			created_at    datetime     null,
			index idx_uph_uid_created (uid, created_at),
			constraint user_password_history_ibfk_1 foreign key (uid) references users (uid)
		)`,
		`create table if not exists user_security_events (
			id         bigint auto_increment primary key,
			uid        bigint       not null,
			event      varchar(64)  not null,
			detail     varchar(500) null,
			created_at datetime     not null,
			index idx_use_uid_created (uid, created_at),
			constraint user_security_events_ibfk_1 foreign key (uid) references users (uid)
		)`,
	}
}

// SchemaDDL exposes the CREATE-only DDL for the black-box tests package.
func SchemaDDL() []string { return schemaDDL() }

// OwnedTables exposes the table ownership list for the black-box tests package.
func OwnedTables() []string { return ownedTables }
