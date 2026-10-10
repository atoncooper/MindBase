// Package db initializes the GORM MySQL connection against the SHARED bilirag
// database and applies app-settings's schema ownership.
//
// Migration policy: CREATE TABLE IF NOT EXISTS only — never ALTER. The tables
// already exist with live data (created by the Python backend via
// Base.metadata.create_all); the DDL below mirrors app/models.py column shapes
// verbatim. app-settings owns user_preferences only — the per-user API key
// config tables (user_embedding_configs / user_asr_configs / user_credentials)
// were retired together with BYOK: nothing reads them anymore, so the service
// neither migrates nor serves them (existing rows are left untouched).
package db

import (
	"fmt"
	"strings"
	"time"

	"app-settings/internal/logger"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
// loc=UTC: the Python stack wrote naive UTC datetimes (datetime.now(utc)).
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

// ownedTables is the full set of tables app-settings may touch with DDL. The
// guard test pins Migrate to exactly this list.
var ownedTables = []string{
	"user_preferences",
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
	}
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
