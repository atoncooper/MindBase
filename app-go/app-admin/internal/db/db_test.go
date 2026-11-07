// Guard test: Migrate must ONLY create admin_user / admin_session /
// admin_audit. The shared bilirag tables (cloud_*, users, rbac_*) belong to
// app-cloud / app-user — if this test ever fails, a shared-table DDL leaked
// into the admin plane and a live schema is at risk of drift (
// red line).
package db

import (
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestSchemaDDLOnlyContainsOwnTables(t *testing.T) {
	ddl := schemaDDL()
	if len(ddl) != 3 {
		t.Fatalf("Migrate must create exactly the 3 admin tables, got %d statements", len(ddl))
	}
	allowed := map[string]bool{
		"admin_user":    false,
		"admin_session": false,
		"admin_audit":   false,
	}
	for _, s := range ddl {
		low := strings.ToLower(s)
		if !strings.Contains(low, "if not exists") {
			t.Fatalf("DDL must be CREATE TABLE IF NOT EXISTS (idempotent), got: %s", s)
		}
		if !strings.Contains(low, "create table") {
			t.Fatalf("only CREATE TABLE DDL is allowed, got: %s", s)
		}
		matched := false
		for name := range allowed {
			if strings.Contains(low, "exists "+name+" (") || strings.Contains(low, "exists "+name+"(") {
				if allowed[name] {
					t.Fatalf("table %s appears twice in schemaDDL", name)
				}
				allowed[name] = true
				matched = true
			}
		}
		if !matched {
			t.Fatalf("unknown table DDL leaked into schemaDDL: %s", s)
		}
	}
	for name, seen := range allowed {
		if !seen {
			t.Fatalf("own table %s missing from schemaDDL", name)
		}
	}
	// admin_session must carry the device fingerprint column that binds a
	// session to the device that created it.
	sessionDDL := ""
	for _, s := range ddl {
		if strings.Contains(strings.ToLower(s), "exists admin_session") {
			sessionDDL = s
		}
	}
	if !strings.Contains(strings.ToLower(sessionDDL), "device_hash") {
		t.Fatalf("admin_session DDL must declare device_hash: %s", sessionDDL)
	}
	for _, forbidden := range []string{
		"cloud_shares", "cloud_files", "cloud_folders",
		"users", "rbac_role", "rbac_user_role", "user_profile",
		// app_pay tables belong to app-pay (Java Flyway): the console only maps
		// them for reads + the controlled grant write. A DDL leak here would
		// drift a money schema — pin it.
		"pay_order", "pay_membership", "pay_membership_event",
		"pay_callback_log", "pay_product", "pay_refund_approval",
	} {
		for _, s := range ddl {
			if strings.Contains(strings.ToLower(s), "exists "+forbidden) {
				t.Fatalf("Migrate must never create shared table %s", forbidden)
			}
		}
	}
}

// A deployment whose admin_session table predates device binding must be
// upgraded in place: ensureSessionColumns adds the column once and is idempotent.
func TestEnsureSessionColumnsAddsDeviceHash(t *testing.T) {
	prev := DB
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("sqlite handle: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	DB = gdb
	t.Cleanup(func() { DB = prev })

	// Legacy table without the fingerprint column.
	if err := DB.Exec(`create table admin_session (
		session_token varchar(128) not null primary key,
		admin_user_id int          not null,
		expires_at    datetime     not null,
		ip            varchar(64)  null,
		user_agent    varchar(500) null,
		created_at    datetime     null
	)`).Error; err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if exists, err := sessionColumnExists("device_hash"); err != nil || exists {
		t.Fatalf("column must be missing before migration: exists=%v err=%v", exists, err)
	}
	if err := ensureSessionColumns(); err != nil {
		t.Fatalf("add device_hash: %v", err)
	}
	if exists, err := sessionColumnExists("device_hash"); err != nil || !exists {
		t.Fatalf("device_hash must exist after migration: exists=%v err=%v", exists, err)
	}
	// Existing rows get the empty default, so they can be recognized as
	// pre-binding sessions and rejected.
	if err := DB.Exec("insert into admin_session (session_token, admin_user_id, expires_at) values (?, ?, datetime('now'))",
		"legacy-token", 1).Error; err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
	var deviceHash string
	if err := DB.Raw("select device_hash from admin_session where session_token = ?", "legacy-token").
		Scan(&deviceHash).Error; err != nil {
		t.Fatalf("read device_hash: %v", err)
	}
	if deviceHash != "" {
		t.Fatalf("legacy rows must default to an empty device hash, got %q", deviceHash)
	}
	// Running it again must be a no-op (no duplicate-column error).
	if err := ensureSessionColumns(); err != nil {
		t.Fatalf("ensureSessionColumns must be idempotent: %v", err)
	}
}

func TestToGormDSN(t *testing.T) {
	cases := []struct{ in, want string }{
		{
			"mysql+aiomysql://mind_base:pw@mysql:3306/mind_base",
			"mind_base:pw@tcp(mysql:3306)/mind_base?charset=utf8mb4&parseTime=True&loc=Local",
		},
		{
			"mysql+pymysql://u:p@127.0.0.1:3306/mind_base?extra=1",
			"u:p@tcp(127.0.0.1:3306)/mind_base?charset=utf8mb4&parseTime=True&loc=Local",
		},
		{
			"mysql://u@host/db",
			"u@tcp(host)/db?charset=utf8mb4&parseTime=True&loc=Local",
		},
	}
	for _, tc := range cases {
		if got := toGormDSN(tc.in); got != tc.want {
			t.Fatalf("toGormDSN(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// PayInit/PayAvailable are the payment module's availability switch: the
// console must degrade to 503 instead of crashing when app_pay is absent, so
// the nil/initialized states are pinned here.
func TestPayConnectionAvailability(t *testing.T) {
	prev := PayDB
	PayDB = nil
	defer func() { PayDB = prev }()

	if PayAvailable() {
		t.Fatal("PayAvailable must be false when the pay connection is not initialized")
	}
	if err := PayPing(); err == nil {
		t.Fatal("PayPing must fail when the pay connection is not initialized")
	}
	if err := PayClose(); err != nil {
		t.Fatalf("PayClose on an uninitialized connection must be a no-op: %v", err)
	}
}
