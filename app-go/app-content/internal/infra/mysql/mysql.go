// Package mysql opens the ONE MySQL connection pool used by the whole
// app-content process. Schema ownership stays with the domain packages
// (internal/infra/db/{board,note,quiz}); this package only owns the connection.
package mysql

import (
	"fmt"
	"strings"
	"time"

	"app-content/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// Open connects with the process-wide pool settings. The DSN accepts the
// SQLAlchemy-style mysql+aiomysql:// shape used by the legacy .env files.
func Open(url string, maxOpen, maxIdle, maxLifetimeSeconds int, debug bool) (*gorm.DB, error) {
	db, err := gorm.Open(mysql.Open(toGormDSN(url)), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(time.Duration(maxLifetimeSeconds) * time.Second)
	return db, nil
}

// Close releases the pool (nil-safe).
func Close(db *gorm.DB) error {
	if db == nil {
		return nil
	}
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// toGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=UTC.
// loc=UTC is mandatory: the note/quiz tables store naive UTC datetimes written
// by the Python backend, so every domain must interpret them the same way.
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
