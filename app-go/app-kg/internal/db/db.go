// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database.
//
// Migration policy: app-kg owns NO tables. The video.kg_status/kg_version
// columns already exist (created by the Python backend via db/system.sql);
// this service is the唯一 writer of those two columns (the mirror of the
// app-bili red line "app-bili 禁止写 kg* 列"), and reads
// collection/favorite_folders/video rows read-only. GORM AutoMigrate is
// deliberately NOT used.
package db

import (
	"fmt"
	"strings"
	"time"

	"app-kg/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
//
// loc=UTC: the Python kg stack compares version/kg_version ints only —
// datetimes are not part of the kg contract; UTC keeps any incidental
// reads consistent with the Python backend's naive-UTC writes.
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
