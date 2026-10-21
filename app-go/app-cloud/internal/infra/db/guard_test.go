package db

import (
	"strings"
	"testing"
)

// Guard: Migrate may only issue DDL against tables app-cloud owns. Every DDL
// statement must start with "create table if not exists <name>" where <name>
// is in ownedTables. Any drift (ALTER/DROP/new table) fails here before it
// can damage the shared bilirag database.
func TestSchemaDDLOnlyTouchesOwnedTables(t *testing.T) {
	allowed := make(map[string]bool, len(ownedTables))
	for _, name := range ownedTables {
		allowed[name] = true
	}
	seen := make(map[string]bool)
	for _, ddl := range schemaDDL() {
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
			t.Fatalf("table %q is not in ownedTables", name)
		}
		seen[name] = true
	}
	for _, name := range ownedTables {
		if !seen[name] {
			t.Fatalf("owned table %q has no DDL", name)
		}
	}
}

// Guard: no statement may contain ALTER / DROP / MODIFY / CHANGE.
func TestSchemaDDLHasNoMutatingStatements(t *testing.T) {
	for _, ddl := range schemaDDL() {
		lower := strings.ToLower(ddl)
		for _, bad := range []string{"alter ", "drop ", "modify ", "change "} {
			if strings.Contains(lower, bad) {
				t.Fatalf("mutating keyword %q found in DDL: %.80s", bad, ddl)
			}
		}
	}
}
