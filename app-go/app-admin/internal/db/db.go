// Package db initializes app-admin's TWO GORM MySQL connections:
//
//   - DB    — the SHARED bilirag database (app-user / app-cloud schema);
//   - PayDB — the app_pay database on app-pay-mysql (Java-owned schema), used
//     only by the payment-operations console. It is optional: when
//     pay_rdbms.url is unset or unreachable, main() leaves PayDB nil and every
//     /api/pay/** route answers 503 while the rest of the console keeps working.
//
// Migration policy: create the three admin_* OWN tables if they do not exist;
// never touch anything else. cloud_shares / cloud_files / cloud_folders /
// users / rbac_* tables are owned by app-cloud / app-user (live data), and the
// pay_* tables are owned by app-pay (Flyway) — this service must NEVER
// AutoMigrate or ALTER either of them (guard test pins schemaDDL).
// The only write onto shared tables is the four moderation columns on
// cloud_shares via UPDATE; the only pay-domain writes are the
// controlled membership grant (pay_membership + pay_membership_event).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-admin/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var (
	// DB is the shared bilirag connection (main console + admin_* own tables).
	DB *gorm.DB
	// PayDB is the app_pay connection (payment console). nil = pay module
	// disabled: /api/pay/** answers 503 and /health reports pay=disabled.
	PayDB *gorm.DB
)

// Init opens the shared bilirag MySQL. dsn may be SQLAlchemy-style
// (mysql+aiomysql://user:pass@host:port/db).
func Init(dsn string, maxOpen, maxIdle, maxLife int, debug bool) error {
	d, err := open(dsn, maxOpen, maxIdle, maxLife, debug)
	if err != nil {
		return err
	}
	DB = d
	return nil
}

// PayInit opens the SECOND connection: app_pay on the app-pay-mysql instance.
//
// The schema belongs to app-pay (Java Flyway); this package never migrates it.
// The connection is pinged once so "initialized" really means reachable: main()
// then degrades to pay disabled instead of failing the whole console, exactly
// the contract's "PayDB 初始化失败 -> /api/pay/** 503" behavior.
func PayInit(dsn string, maxOpen, maxIdle, maxLife int, debug bool) error {
	d, err := open(dsn, maxOpen, maxIdle, maxLife, debug)
	if err != nil {
		return err
	}
	sqlDB, err := d.DB()
	if err != nil {
		return fmt.Errorf("get pay *sql.DB: %w", err)
	}
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return fmt.Errorf("ping pay mysql: %w", err)
	}
	PayDB = d
	return nil
}

// open is the shared GORM MySQL opener used by both connections.
func open(dsn string, maxOpen, maxIdle, maxLife int, debug bool) (*gorm.DB, error) {
	gormDSN := toGormDSN(dsn)
	d, err := gorm.Open(mysql.Open(gormDSN), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := d.DB()
	if err != nil {
		return nil, fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(time.Duration(maxLife) * time.Second)
	return d, nil
}

func Close() error {
	return closeDB(DB)
}

// PayClose closes the app_pay connection (graceful shutdown).
func PayClose() error {
	return closeDB(PayDB)
}

func closeDB(d *gorm.DB) error {
	if d == nil {
		return nil
	}
	sqlDB, err := d.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// Ping checks the main DB connection is actually usable — /health must
// truthfully probe it (SELECT 1; failure -> 503), not just report that the
// process runs.
func Ping() error {
	return pingDB(DB)
}

// PayPing probes the app_pay connection (SELECT 1). PayAvailable()==false is
// reported separately: /health distinguishes "not configured" from "broken".
func PayPing() error {
	return pingDB(PayDB)
}

// PayAvailable reports whether the payment console has a live connection.
func PayAvailable() bool { return PayDB != nil }

func pingDB(d *gorm.DB) error {
	if d == nil {
		return fmt.Errorf("db not initialized")
	}
	var one int
	if err := d.Raw("SELECT 1").Scan(&one).Error; err != nil {
		return err
	}
	return nil
}

// Migrate creates ONLY the admin-owned tables, CREATE TABLE IF NOT EXISTS,
// then adds the columns introduced after the initial release to those same
// tables. NEVER add an AutoMigrate here: GORM would silently ALTER the shared
// schema. The pay_* tables are deliberately absent too — they belong to app-pay.
func Migrate() error {
	for _, ddl := range schemaDDL() {
		if err := DB.Exec(ddl).Error; err != nil {
			return fmt.Errorf("exec ddl: %w", err)
		}
	}
	return ensureSessionColumns()
}

// ensureSessionColumns brings a pre-existing admin_session table up to date.
// CREATE TABLE IF NOT EXISTS does not touch an existing table, so a deployment
// running since before device binding existed would otherwise miss the column
// and every session write would fail. Only admin_session is altered.
func ensureSessionColumns() error {
	exists, err := sessionColumnExists("device_hash")
	if err != nil {
		return fmt.Errorf("inspect admin_session columns: %w", err)
	}
	if exists {
		return nil
	}
	ddl := "ALTER TABLE admin_session ADD COLUMN device_hash varchar(64) NOT NULL DEFAULT ''"
	if DB.Dialector.Name() == "mysql" {
		ddl += " AFTER user_agent"
	}
	if err := DB.Exec(ddl).Error; err != nil {
		return fmt.Errorf("add admin_session.device_hash: %w", err)
	}
	return nil
}

// sessionColumnExists checks admin_session for one column. MySQL is asked
// through information_schema; the SQLite test database through PRAGMA.
func sessionColumnExists(column string) (bool, error) {
	if DB.Dialector.Name() == "mysql" {
		var n int64
		err := DB.Raw(
			"SELECT COUNT(*) FROM information_schema.columns "+
				"WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
			"admin_session", column).Scan(&n).Error
		return n > 0, err
	}
	var cols []struct {
		Name string `gorm:"column:name"`
	}
	if err := DB.Raw("PRAGMA table_info(admin_session)").Scan(&cols).Error; err != nil {
		return false, err
	}
	for _, col := range cols {
		if col.Name == column {
			return true, nil
		}
	}
	return false, nil
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
			device_hash   varchar(64)  not null default '',
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
