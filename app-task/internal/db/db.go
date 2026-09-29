// Package db initializes the GORM MySQL connection. DSN may be SQLAlchemy-style
// (mysql+aiomysql://...) — converted to Go mysql driver DSN.
package db

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"app-task/internal/logger"
	"app-task/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Options carries the full MySQL connection configuration. Zero values fall
// back to safe defaults (declared in default.yaml).
type Options struct {
	DSN                string // may be sqlalchemy-style (mysql+aiomysql://...)
	MaxOpenConns       int
	MaxIdleConns       int
	ConnMaxLifetimeSec int // 0 = reuse forever
	ConnMaxIdleTimeSec int // 0 = idle conns never closed early
	// go-sql-driver timeouts (seconds); 0 = driver default, which for
	// read/write is "no timeout" — a hung DB would freeze a worker forever.
	DialTimeoutSec  int
	ReadTimeoutSec  int
	WriteTimeoutSec int
	TLS             string // "" | "true" | "skip-verify" (passed to the driver)
	PrepareStmt     bool   // GORM prepared-statement cache on pooled conns
	SlowThresholdMS int    // GORM slow query log threshold (0 = 200ms)
	Debug           bool
}

// Init opens MySQL with the given options.
func Init(opts Options) error {
	gormDSN, err := toGormDSN(opts.DSN, dsnParams(opts))
	if err != nil {
		return fmt.Errorf("build dsn: %w", err)
	}
	d, err := gorm.Open(mysql.Open(gormDSN), &gorm.Config{
		Logger:      logger.NewGORMLogger(opts.Debug, time.Duration(opts.SlowThresholdMS)*time.Millisecond),
		PrepareStmt: opts.PrepareStmt,
	})
	if err != nil {
		return fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := d.DB()
	if err != nil {
		return fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(opts.MaxOpenConns)
	sqlDB.SetMaxIdleConns(opts.MaxIdleConns)
	if opts.ConnMaxLifetimeSec > 0 {
		sqlDB.SetConnMaxLifetime(time.Duration(opts.ConnMaxLifetimeSec) * time.Second)
	}
	if opts.ConnMaxIdleTimeSec > 0 {
		sqlDB.SetConnMaxIdleTime(time.Duration(opts.ConnMaxIdleTimeSec) * time.Second)
	}
	DB = d
	return nil
}

// dsnParams assembles the driver params appended to every DSN: charset/parse
// defaults plus the configured timeouts and TLS mode.
func dsnParams(opts Options) map[string]string {
	p := map[string]string{
		"charset":   "utf8mb4",
		"parseTime": "True",
		"loc":       "Local",
	}
	if opts.DialTimeoutSec > 0 {
		p["timeout"] = fmt.Sprintf("%ds", opts.DialTimeoutSec)
	}
	if opts.ReadTimeoutSec > 0 {
		p["readTimeout"] = fmt.Sprintf("%ds", opts.ReadTimeoutSec)
	}
	if opts.WriteTimeoutSec > 0 {
		p["writeTimeout"] = fmt.Sprintf("%ds", opts.WriteTimeoutSec)
	}
	if opts.TLS != "" {
		p["tls"] = opts.TLS
	}
	return p
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

// Migrate creates the app-task owned schema (tables + composite indexes) on
// its own MySQL instance. app-task no longer shares a database with the main
// app, so it must create its tables itself at startup.
//
// Indexes are declared via GORM struct tags on the models (see model.go), so
// AutoMigrate creates them — do NOT hand-write "CREATE INDEX IF NOT EXISTS"
// here: that is SQLite syntax and MySQL 8 rejects it.
func Migrate() error {
	if err := dedupeAPIKeyNames(); err != nil {
		return fmt.Errorf("dedupe api_key names: %w", err)
	}
	if err := DB.AutoMigrate(
		&model.Task{},
		&model.TaskLog{},
		&model.EmailMessage{},
		&model.Script{},
		&model.ScriptLog{},
		&model.ScriptRun{},
		&model.APIKey{},
		&model.Secret{},
		&model.WebUIUser{},
		&model.ClusterNode{},
	); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	return nil
}

// dedupeAPIKeyNames renames duplicate api_key names (the oldest row keeps the
// name, newer rows get a -dupN suffix) so the UNIQUE index on name — a later
// addition — can be created on databases written before the constraint
// existed. Idempotent: no-op when there are no duplicates.
func dedupeAPIKeyNames() error {
	var names []string
	err := DB.Model(&model.APIKey{}).
		Select("name").Group("name").Having("COUNT(*) > 1").
		Pluck("name", &names).Error
	if err != nil {
		return err
	}
	for _, name := range names {
		var rows []model.APIKey
		if err := DB.Where("name = ?", name).Order("id ASC").Find(&rows).Error; err != nil {
			return err
		}
		for i := 1; i < len(rows); i++ {
			newName := name + "-dup2"
			for suffix := 2; ; suffix++ {
				var taken int64
				if err := DB.Model(&model.APIKey{}).Where("name = ?", newName).Count(&taken).Error; err != nil {
					return err
				}
				if taken == 0 {
					break
				}
				newName = fmt.Sprintf("%s-dup%d", name, suffix+1)
			}
			if err := DB.Model(&model.APIKey{}).Where("id = ?", rows[i].ID).
				Update("name", newName).Error; err != nil {
				return err
			}
			slog.Info("[DB] renamed duplicate api_key name for unique index", "old", name, "id", rows[i].ID, "new", newName)
		}
	}
	return nil
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db to the go-sql-driver
// DSN, appending the given params (charset/timeouts/tls) to the query string.
// Any query string already present in the input is dropped — params come from
// configuration, not from the DSN.
func toGormDSN(sqlalchemyURL string, params map[string]string) (string, error) {
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	// s = user:pass@host:port/db[?params]
	atIdx := strings.LastIndex(s, "@")
	var userPass, hostDB string
	if atIdx < 0 {
		userPass, hostDB = "", s
	} else {
		userPass, hostDB = s[:atIdx], s[atIdx+1:]
	}
	// split "host:port" and "/db[?params]"
	slashIdx := strings.Index(hostDB, "/")
	var hostPort, rest string
	if slashIdx < 0 {
		hostPort, rest = hostDB, ""
	} else {
		hostPort = hostDB[:slashIdx]
		rest = hostDB[slashIdx+1:]
		if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
			rest = rest[:qIdx] // drop any DSN-provided params: config wins
		}
	}
	if hostPort == "" {
		return "", fmt.Errorf("dsn %q: missing host", sqlalchemyURL)
	}
	q := buildQuery(params)
	dsn := userPass + "@tcp(" + hostPort + ")/" + rest
	if q != "" {
		dsn += "?" + q
	}
	return dsn, nil
}

// buildQuery renders params sorted by key (deterministic DSNs for tests).
func buildQuery(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	return strings.Join(parts, "&")
}
