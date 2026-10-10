package db

import (
	"strings"
	"testing"
)

// Guard: Migrate must stay CREATE-TABLE-IF-NOT-EXISTS only. Any ALTER/DROP
// against the shared in-production config schema is a bug.
func TestMigrateCreateOnly(t *testing.T) {
	for _, ddl := range schemaDDL() {
		u := strings.ToUpper(ddl)
		if !strings.HasPrefix(u, "CREATE TABLE IF NOT EXISTS") {
			t.Fatalf("ddl does not start with CREATE TABLE IF NOT EXISTS: %.80s", ddl)
		}
		for _, banned := range []string{"ALTER ", "DROP ", "MODIFY ", "CHANGE "} {
			if strings.Contains(u, banned) {
				t.Fatalf("ddl contains banned clause %q: %.120s", banned, ddl)
			}
		}
	}
}

// Guard: the owned-tables list stays in sync with the DDL. After the BYOK
// retirement the only owned table is user_preferences.
func TestOwnedTablesCovered(t *testing.T) {
	seen := map[string]bool{}
	for _, ddl := range schemaDDL() {
		u := strings.ToUpper(ddl)
		for _, tbl := range ownedTables {
			if strings.Contains(u, "CREATE TABLE IF NOT EXISTS "+strings.ToUpper(tbl)) {
				seen[tbl] = true
			}
		}
	}
	for _, tbl := range ownedTables {
		if !seen[tbl] {
			t.Errorf("owned table %q has no CREATE statement", tbl)
		}
	}
}
