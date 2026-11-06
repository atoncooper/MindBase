package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"app-kg/internal/logger"

	mysqlDriver "gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// DB is the initialized GORM handle. Repos receive Gorm() and never touch the
// driver or the pool directly.
type DB struct {
	db *gorm.DB
}

// Open initializes the connection pool against the SHARED bilirag database.
// dsn may be SQLAlchemy-style (mysql+aiomysql://...).
//
// loc=UTC: the KG contract compares version/kg_version ints only — datetimes
// are not part of it; UTC keeps any incidental reads consistent with the
// Python backend's naive-UTC writes.
func Open(cfg Config, debug bool) (*DB, error) {
	gormDSN := toGormDSN(cfg.URL)
	d, err := gorm.Open(mysqlDriver.Open(gormDSN), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := d.DB()
	if err != nil {
		return nil, fmt.Errorf("get *sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(time.Duration(cfg.ConnMaxLifetime) * time.Second)
	return &DB{db: d}, nil
}

// Gorm exposes the handle for repositories.
func (d *DB) Gorm() *gorm.DB {
	if d == nil {
		return nil
	}
	return d.db
}

// Close releases the pool.
func (d *DB) Close() error {
	if d == nil || d.db == nil {
		return nil
	}
	sqlDB, err := d.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// Ping verifies the pool with a real round-trip (health probe).
func (d *DB) Ping(ctx context.Context) error {
	if d == nil || d.db == nil {
		return fmt.Errorf("mysql not connected")
	}
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return d.db.WithContext(pingCtx).Exec("SELECT 1").Error
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
