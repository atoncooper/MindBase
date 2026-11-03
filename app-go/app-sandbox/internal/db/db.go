// Package db initializes the GORM MySQL connection against the shared mind_base
// database and owns the app-sandbox schema.
//
// Migration policy: AutoMigrate of the five sandbox_* tables ONLY (CREATE /
// additive ALTER). The service never touches other services' tables; a guard
// test pins the owned table list.
package db

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"app-sandbox/internal/logger"
	"app-sandbox/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

// OwnedModels is the single source of truth for the schema this service owns.
// AutoMigrate and OwnedTables both derive from it, so they cannot drift.
var OwnedModels = []any{
	&model.SandboxLease{},
	&model.SandboxExecution{},
	&model.SandboxArtifact{},
	&model.SandboxUsageDaily{},
	&model.SandboxAudit{},
}

// Init opens MySQL. dsn may be SQLAlchemy-style (mysql+aiomysql://...).
// loc=UTC keeps timestamps comparable to the other Go services.
func Init(dsn string, maxOpen, maxIdle, maxLife int, debug bool) error {
	gormDSN := ToGormDSN(dsn)
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

// OwnedTables returns the sorted list of tables app-sandbox may create/alter.
func OwnedTables() []string {
	out := make([]string, 0, len(OwnedModels))
	for _, m := range OwnedModels {
		if named, ok := m.(interface{ TableName() string }); ok {
			out = append(out, named.TableName())
		}
	}
	sort.Strings(out)
	return out
}

// Migrate creates/extends the sandbox schema. AutoMigrate is additive: it never
// drops columns or tables that other writers might rely on.
func Migrate() error {
	if DB == nil {
		return fmt.Errorf("db not initialized")
	}
	if err := DB.AutoMigrate(OwnedModels...); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	return nil
}

// Ping reports database reachability for /health and /ready.
func Ping() error {
	if DB == nil {
		return fmt.Errorf("db not initialized")
	}
	return DB.Exec("select 1").Error
}

// ToGormDSN converts mysql+aiomysql://user:pass@host:port/db
// to user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True&loc=UTC.
func ToGormDSN(sqlalchemyURL string) string {
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
	// Already a GORM DSN (user:pass@tcp(host:port)/db): only append params.
	if strings.HasPrefix(hostDB, "tcp(") {
		if strings.Contains(hostDB, "?") {
			return s
		}
		return s + "?charset=utf8mb4&parseTime=True&loc=UTC"
	}
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
