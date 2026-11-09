package tests

import (
	authdb "app-user/internal/infra/db/auth"
	"strings"
	"testing"
)

// Guard: Migrate may only issue DDL against tables app-user owns. Every DDL
// statement must start with "create table if not exists <name>" where <name>
// is in authdb.OwnedTables(). Any drift (new table, renamed table, ALTER) fails here
// before it can damage the shared bilirag database.
func TestAuthSchemaDDLOnlyTouchesOwnedTables(t *testing.T) {
	allowed := make(map[string]bool, len(authdb.OwnedTables()))
	for _, name := range authdb.OwnedTables() {
		allowed[name] = true
	}
	seen := make(map[string]bool)
	for _, ddl := range authdb.SchemaDDL() {
		const prefix = "create table if not exists "
		if !strings.HasPrefix(strings.ToLower(ddl), prefix) {
			t.Fatalf("non-CREATE-TABLE DDL is forbidden in Migrate (ALTERs can drift the shared schema): %.80s", ddl)
		}
		rest := ddl[len(prefix):]
		name := rest
		if i := strings.IndexAny(rest, " \t\n("); i >= 0 {
			name = rest[:i]
		}
		if !allowed[name] {
			t.Fatalf("table %q is not in authdb.OwnedTables()", name)
		}
		seen[name] = true
	}
	for _, name := range authdb.OwnedTables() {
		if !seen[name] {
			t.Fatalf("owned table %q has no DDL", name)
		}
	}
}

// Guard: coding_plans moved to the settings domain (user configuration, not
// identity). The auth DDL must not re-acquire the table — the settings guard
// test (db_guard_settings_test.go) pins the new owner.
func TestAuthDoesNotOwnCodingPlans(t *testing.T) {
	for _, name := range authdb.OwnedTables() {
		if name == "coding_plans" {
			t.Fatal("coding_plans must be owned by the settings domain, not authdb")
		}
	}
	for _, ddl := range authdb.SchemaDDL() {
		if strings.Contains(strings.ToLower(ddl), "coding_plans") {
			t.Fatal("auth DDL still creates coding_plans; it belongs to settingsdb")
		}
	}
}

// Guard: no statement may contain ALTER / DROP / MODIFY / CHANGE — this
// service owns schema creation only, never mutation of existing tables.
func TestAuthSchemaDDLHasNoMutatingStatements(t *testing.T) {
	for _, ddl := range authdb.SchemaDDL() {
		lower := strings.ToLower(ddl)
		for _, bad := range []string{"alter ", "drop ", "modify ", "change "} {
			if strings.Contains(lower, bad) {
				t.Fatalf("mutating keyword %q found in DDL: %.80s", bad, ddl)
			}
		}
	}
}
