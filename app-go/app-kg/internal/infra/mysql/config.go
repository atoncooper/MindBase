// Package mysql owns the MySQL/GORM initialization of app-kg: the connection
// settings (this file) and the connection itself (mysql.go).
//
// Migration policy: app-kg owns NO tables. The video.kg_status/kg_version
// columns already exist (created by the Python backend via db/system.sql);
// this service is their ONLY writer, and it reads collection/favorite_folders
// read-only. GORM AutoMigrate is deliberately NOT used — zero DDL here.
package mysql

import (
	"errors"
	"strings"
)

// Config is the `rdbms:` block of default.yaml. It is declared in the infra
// layer — next to the code that consumes it — and embedded by
// internal/config, which remains the only place that loads YAML/env.
type Config struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

// Validate fails loud on a missing DSN: the service cannot run without the
// shared bilirag MySQL (bookkeeping + scope resolution).
func (c Config) Validate() error {
	if strings.TrimSpace(c.URL) == "" {
		return errors.New("rdbms.url is required (APPKG__RDBMS__URL)")
	}
	return nil
}
