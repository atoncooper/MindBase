// Process-wide data-store configuration.
//
// app-content is ONE service, so it must open exactly one MySQL pool, one
// MongoDB client and one Redis client. The three domains receive the same
// handles; there is no per-domain DSN/URI. Legacy per-domain environment
// variables (APPBOARD__/APPNOTE__/APPQUIZ__ + the old shared RDBMS__URL /
// MONGO__URI / REDIS__URL) are still accepted, but conflicting values are a
// startup error instead of silently splitting the service across databases.
package config

import (
	"fmt"
	"strconv"
	"strings"
)

// MySQLConfig configures the single MySQL connection pool.
type MySQLConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

// MongoConfig configures the single MongoDB client. Database is the shared
// content database (notes/quiz); BoardDatabase keeps the historical board
// collection location (MindBase) so the merge does not orphan existing boards.
// Empty BoardDatabase means "same as Database".
type MongoConfig struct {
	URI            string `yaml:"uri"`
	Database       string `yaml:"database"`
	BoardDatabase  string `yaml:"board_database"`
	TimeoutSeconds int    `yaml:"timeout_seconds"`
}

// RedisConfig configures the single Redis client. BoardCacheTTLSeconds is the
// board read-cache backstop TTL.
type RedisConfig struct {
	URL                  string `yaml:"url"`
	KeyPrefix            string `yaml:"key_prefix"`
	BoardCacheTTLSeconds int    `yaml:"board_cache_ttl_seconds"`
}

// DatabaseConfig groups the process-wide data stores.
type DatabaseConfig struct {
	MySQL MySQLConfig `yaml:"mysql"`
	Mongo MongoConfig `yaml:"mongo"`
	Redis RedisConfig `yaml:"redis"`
}

// BoardMongoDatabase resolves the Mongo database used for board documents
// (legacy isolation), falling back to the shared database.
func (d DatabaseConfig) BoardMongoDatabase() string {
	if strings.TrimSpace(d.Mongo.BoardDatabase) != "" {
		return strings.TrimSpace(d.Mongo.BoardDatabase)
	}
	return strings.TrimSpace(d.Mongo.Database)
}

// applyDatabaseEnvOverrides maps the legacy per-domain env vars onto the one
// process-wide DatabaseConfig. It returns an error when legacy variables
// disagree — that is the split-brain case this refactor exists to prevent.
func applyDatabaseEnvOverrides(db *DatabaseConfig) error {
	// ── MySQL: CONTENT__DATABASE__MYSQL__URL > RDBMS__URL > per-domain legacy ──
	mysqlCandidates := []struct {
		key   string
		value string
	}{
		{"APPBOARD__RDBMS__URL", env("APPBOARD__RDBMS__URL")},
		{"APPNOTE__RDBMS__URL", env("APPNOTE__RDBMS__URL")},
		{"APPQUIZ__RDBMS__URL", env("APPQUIZ__RDBMS__URL")},
		{"RDBMS__URL", env("RDBMS__URL")},
	}
	if v := env("CONTENT__DATABASE__MYSQL__URL"); v != "" {
		db.MySQL.URL = v
	} else {
		first := ""
		firstKey := ""
		for _, c := range mysqlCandidates {
			if c.value == "" {
				continue
			}
			if first == "" {
				first, firstKey = c.value, c.key
				continue
			}
			if c.value != first {
				return fmt.Errorf("conflicting MySQL URLs: %s differs from %s — app-content has one MySQL pool; set CONTENT__DATABASE__MYSQL__URL and remove the legacy per-domain values", firstKey, c.key)
			}
		}
		if first != "" {
			db.MySQL.URL = first
		}
	}
	envInt("CONTENT__DATABASE__MYSQL__MAX_OPEN_CONNS", &db.MySQL.MaxOpenConns)
	envInt("CONTENT__DATABASE__MYSQL__MAX_IDLE_CONNS", &db.MySQL.MaxIdleConns)
	envInt("CONTENT__DATABASE__MYSQL__CONN_MAX_LIFETIME", &db.MySQL.ConnMaxLifetime)

	// ── Mongo: CONTENT__DATABASE__MONGO__URI > MONGO__URI > APPBOARD__MONGO__URI ──
	mongoCandidates := []struct {
		key   string
		value string
	}{
		{"APPBOARD__MONGO__URI", env("APPBOARD__MONGO__URI")},
		{"MONGO__URI", env("MONGO__URI")},
	}
	if v := env("CONTENT__DATABASE__MONGO__URI"); v != "" {
		db.Mongo.URI = v
	} else {
		first := ""
		firstKey := ""
		for _, c := range mongoCandidates {
			if c.value == "" {
				continue
			}
			if first == "" {
				first, firstKey = c.value, c.key
				continue
			}
			if c.value != first {
				return fmt.Errorf("conflicting MongoDB URIs: %s differs from %s — app-content has one MongoDB client; set CONTENT__DATABASE__MONGO__URI and remove the legacy values", firstKey, c.key)
			}
		}
		if first != "" {
			db.Mongo.URI = first
		}
	}
	if v := env("CONTENT__DATABASE__MONGO__DATABASE"); v != "" {
		db.Mongo.Database = v
	}
	if v := env("CONTENT__DATABASE__MONGO__BOARD_DATABASE"); v != "" {
		db.Mongo.BoardDatabase = v
	} else if v := env("APPBOARD__MONGO__DB_NAME"); v != "" {
		// Historical board database (MindBase) — board only, notes/quiz keep
		// the shared database.
		db.Mongo.BoardDatabase = v
	}
	envInt("CONTENT__DATABASE__MONGO__TIMEOUT_SECONDS", &db.Mongo.TimeoutSeconds)

	// ── Redis: CONTENT__DATABASE__REDIS__URL > REDIS__URL > quiz legacy ──
	if v := env("CONTENT__DATABASE__REDIS__URL"); v != "" {
		db.Redis.URL = v
	} else if v := env("REDIS__URL"); v != "" {
		db.Redis.URL = v
	} else if v := env("APPQUIZ__REDIS__URL"); v != "" {
		db.Redis.URL = v
	} else if v := env("APPBOARD__REDIS__URL"); v != "" {
		db.Redis.URL = v
	}
	if v := env("CONTENT__DATABASE__REDIS__KEY_PREFIX"); v != "" {
		db.Redis.KeyPrefix = v
	} else if v := env("APPQUIZ__REDIS__KEY_PREFIX"); v != "" {
		db.Redis.KeyPrefix = v
	}
	envInt("CONTENT__DATABASE__REDIS__BOARD_CACHE_TTL_SECONDS", &db.Redis.BoardCacheTTLSeconds)
	if v := env("APPBOARD__REDIS__CACHE_TTL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			db.Redis.BoardCacheTTLSeconds = n
		}
	}
	return nil
}

// applyDatabaseDefaults fills the process-wide data-store defaults.
func applyDatabaseDefaults(db *DatabaseConfig) {
	if db.MySQL.MaxOpenConns == 0 {
		db.MySQL.MaxOpenConns = 20
	}
	if db.MySQL.MaxIdleConns == 0 {
		db.MySQL.MaxIdleConns = 10
	}
	if db.MySQL.ConnMaxLifetime == 0 {
		db.MySQL.ConnMaxLifetime = 1800
	}
	if db.Mongo.TimeoutSeconds == 0 {
		db.Mongo.TimeoutSeconds = 10
	}
	if db.Mongo.Database == "" {
		db.Mongo.Database = "mind_base"
	}
	if db.Mongo.BoardDatabase == "" {
		db.Mongo.BoardDatabase = "MindBase"
	}
	if db.Redis.KeyPrefix == "" {
		db.Redis.KeyPrefix = "mind-base:"
	}
	if db.Redis.BoardCacheTTLSeconds == 0 {
		db.Redis.BoardCacheTTLSeconds = 300
	}
}

// validateDatabase checks the one-pool invariant and required secrets.
func validateDatabase(db *DatabaseConfig) error {
	if strings.TrimSpace(db.MySQL.URL) == "" {
		return fmt.Errorf("database.mysql.url is required (CONTENT__DATABASE__MYSQL__URL)")
	}
	if strings.TrimSpace(db.Mongo.URI) == "" {
		return fmt.Errorf("database.mongo.uri is required (CONTENT__DATABASE__MONGO__URI)")
	}
	if strings.TrimSpace(db.Mongo.Database) == "" {
		return fmt.Errorf("database.mongo.database must not be empty")
	}
	if db.MySQL.MaxOpenConns <= 0 || db.MySQL.MaxIdleConns <= 0 || db.MySQL.ConnMaxLifetime <= 0 {
		return fmt.Errorf("database.mysql pool settings must be positive")
	}
	if db.Mongo.TimeoutSeconds <= 0 {
		return fmt.Errorf("database.mongo.timeout_seconds must be positive")
	}
	return nil
}
