// Guard test: Migrate must ONLY create admin_user / admin_session /
// admin_audit. The shared bilirag tables (cloud_*, users, rbac_*) belong to
// app-cloud / app-auth — if this test ever fails, a shared-table DDL leaked
// into the admin plane and a live schema is at risk of drift (plan/1.0.16
// red line).
package db

import (
	"strings"
	"testing"
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
	for _, forbidden := range []string{
		"cloud_shares", "cloud_files", "cloud_folders",
		"users", "rbac_role", "rbac_user_role", "user_profile",
	} {
		for _, s := range ddl {
			if strings.Contains(strings.ToLower(s), "exists "+forbidden) {
				t.Fatalf("Migrate must never create shared table %s", forbidden)
			}
		}
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
