// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-admin's schema ownership.
//
// Migration policy: create the three admin_* OWN tables if they do not exist;
// never touch anything else. cloud_shares / cloud_files / cloud_folders /
// users / rbac_* tables are owned by app-cloud / app-auth (live data) — this
// service must NEVER AutoMigrate or ALTER them (guard test pins schemaDDL).
// The only write onto shared tables is the four moderation columns on
// cloud_shares via UPDATE (plan/1.0.16).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-admin/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://user:pass@host:port/db).
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

// Ping checks the DB connection is actually usable — /health must truthfully
// probe it (SELECT 1; failure -> 503), not just report that the process runs.
func Ping() error {
	if DB == nil {
		return fmt.Errorf("db not initialized")
	}
	var one int
	if err := DB.Raw("SELECT 1").Scan(&one).Error; err != nil {
		return err
	}
	return nil
}

// Migrate creates ONLY the admin-owned tables, CREATE TABLE IF NOT EXISTS.
// NEVER add an AutoMigrate here: GORM would silently ALTER the shared schema.
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
		`create table if not exists admin_user (
			id                   int auto_increment primary key,
			username             varchar(64)  not null,
			password_hash        varchar(100) not null,
			role                 varchar(20)  not null default 'viewer',
			must_change_password tinyint(1)   not null default 1,
			last_login_at        datetime     null,
			created_at           datetime     null,
			updated_at           datetime     null,
			constraint uq_admin_user_username unique (username)
		)`,
		`create table if not exists admin_session (
			session_token varchar(128) not null primary key,
			admin_user_id int          not null,
			expires_at    datetime     not null,
			ip            varchar(64)  null,
			user_agent    varchar(500) null,
			created_at    datetime     null,
			index ix_admin_session_user (admin_user_id),
			index ix_admin_session_expires (expires_at)
		)`,
		`create table if not exists admin_audit (
			id          bigint auto_increment primary key,
			admin_name  varchar(64)  not null,
			action      varchar(32)  not null,
			target_type varchar(32)  null,
			target_id   varchar(64)  null,
			detail      varchar(500) null,
			created_at  datetime     null,
			index ix_admin_audit_time (created_at),
			index ix_admin_audit_admin (admin_name, id)
		)`,
	}
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=Local.
// loc=Local keeps DATETIME wall-clock semantics aligned with the rest of the
// Go fleet (Asia/Shanghai pinned via time.Local in main.go).
func toGormDSN(sqlalchemyURL string) string {
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	// s = user:pass@host:port/db[?params]
	atIdx := strings.LastIndex(s, "@")
	if atIdx < 0 {
		return s + "?charset=utf8mb4&parseTime=True&loc=Local"
	}
	userPass := s[:atIdx]
	hostDB := s[atIdx+1:]
	// split "host:port" and "/db[?params]"
	slashIdx := strings.Index(hostDB, "/")
	if slashIdx < 0 {
		// no db specified
		return userPass + "@tcp(" + hostDB + ")/?charset=utf8mb4&parseTime=True&loc=Local"
	}
	hostPort := hostDB[:slashIdx]
	rest := hostDB[slashIdx+1:] // db[?params]
	// drop any existing query string (we add our own)
	if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
		rest = rest[:qIdx]
	}
	return userPass + "@tcp(" + hostPort + ")/" + rest + "?charset=utf8mb4&parseTime=True&loc=Local"
}
