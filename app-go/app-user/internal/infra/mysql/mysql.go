package mysql

import (
	"fmt"
	"strings"
	"time"

	"app-user/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"os"
)

// Init opens the single shared MySQL connection for the whole user domain.
// dsn may be SQLAlchemy-style (mysql+aiomysql://...). loc=UTC mirrors the
// Python-era naive-UTC storage contract shared by auth/settings/bili.
func Init(dsn string, maxOpen, maxIdle, maxLife, maxIdleTime int, debug bool) (*gorm.DB, error) {
	d, err := gorm.Open(mysql.Open(toGormDSN(dsn)), &gorm.Config{Logger: logger.NewGORMLogger(debug)})
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
	if maxIdleTime > 0 {
		sqlDB.SetConnMaxIdleTime(time.Duration(maxIdleTime) * time.Second)
	}
	return d, nil
}

// Close closes the shared connection.
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
func toGormDSN(sqlalchemyURL string) string {
	// Bound every auth query: a stolen-token flood must fail fast instead of
	// holding connections until the pool is exhausted.
	baseParams := "charset=utf8mb4&parseTime=True&loc=UTC&timeout=5s&readTimeout=10s&writeTimeout=10s"
	tlsParam := ""
	if v := os.Getenv("MYSQL_TLS_MODE"); v != "" {
		tlsParam = "&tls=" + v
	}
	s := sqlalchemyURL
	for _, p := range []string{"mysql+aiomysql://", "mysql+pymysql://", "mysql://"} {
		s = strings.TrimPrefix(s, p)
	}
	atIdx := strings.LastIndex(s, "@")
	if atIdx < 0 {
		return s + "?" + baseParams + tlsParam
	}
	userPass := s[:atIdx]
	hostDB := s[atIdx+1:]
	slashIdx := strings.Index(hostDB, "/")
	if slashIdx < 0 {
		return userPass + "@tcp(" + hostDB + ")/?" + baseParams + tlsParam
	}
	hostPort := hostDB[:slashIdx]
	rest := hostDB[slashIdx+1:]
	if qIdx := strings.Index(rest, "?"); qIdx >= 0 {
		rest = rest[:qIdx]
	}
	return userPass + "@tcp(" + hostPort + ")/" + rest + "?" + baseParams + tlsParam
}
