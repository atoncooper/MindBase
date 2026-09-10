// Package db initializes the GORM MySQL connection. DSN may be SQLAlchemy-style
// (mysql+aiomysql://...) — converted to Go mysql driver DSN.
//
// Schema ownership: the pay_* tables belong to app-pay (Java, schema.sql).
// This service must NEVER AutoMigrate them — Migrate only creates the admin's
// own payadmin_user table, so GORM can never silently drift the pay schema.
package db

import (
	"fmt"
	"strings"
	"time"

	"app-pay-admin/internal/logger"
	"app-pay-admin/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be mysql+aiomysql://user:pass@host:port/db.
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

// Migrate creates ONLY the admin-owned payadmin_user table (accounts for the
// embedded console). The pay_* tables are Java-owned (app-pay schema.sql);
// running AutoMigrate on them could silently add/drop columns in a money
// schema, so they are deliberately excluded here. Their Go models in
// internal/model are plain row mappings used for reads and the one controlled
// membership write.
func Migrate() error {
	if err := DB.AutoMigrate(
		&model.PayAdminUser{},
	); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	return nil
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=Local.
// loc=Local keeps DATETIME semantics identical to app-pay's JVM, whose
// timezone is pinned to Asia/Shanghai (main.go sets time.Local accordingly).
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
