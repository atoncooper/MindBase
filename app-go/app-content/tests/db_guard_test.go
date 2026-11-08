package tests

import (
	"strings"
	"testing"

	dbboard "app-content/internal/infra/db/board"
	dbnote "app-content/internal/infra/db/note"
	dbquiz "app-content/internal/infra/db/quiz"
)

// Guard: board Migrate is CREATE-only against its own table (same policy as
// note/quiz; no ALTER on shared databases).
func TestBoardSchemaDDLGuard(t *testing.T) {
	ddl := dbboard.SchemaDDL()
	owned := dbboard.OwnedTables()
	if len(ddl) == 0 || len(owned) == 0 {
		t.Fatal("board DDL/owned tables must not be empty")
	}
	seen := map[string]bool{}
	for _, stmt := range ddl {
		upper := strings.ToUpper(stmt)
		if !strings.HasPrefix(upper, "CREATE TABLE IF NOT EXISTS") {
			t.Fatalf("ddl does not start with CREATE TABLE IF NOT EXISTS: %.80s", stmt)
		}
		for _, banned := range []string{"ALTER ", "DROP ", "MODIFY ", "CHANGE "} {
			if strings.Contains(upper, banned) {
				t.Fatalf("ddl contains banned clause %q: %.120s", banned, stmt)
			}
		}
		for _, tbl := range owned {
			if strings.Contains(upper, "CREATE TABLE IF NOT EXISTS "+strings.ToUpper(tbl)+" (") {
				seen[tbl] = true
			}
		}
	}
	for _, tbl := range owned {
		if !seen[tbl] {
			t.Errorf("owned table %q has no CREATE statement", tbl)
		}
	}
}

// Guard: note Migrate may only issue CREATE-TABLE-IF-NOT-EXISTS DDL against
// its own tables, and every owned table must have DDL. Any drift (ALTER/DROP/
// new table) fails here before it can damage the shared MindBase database.
func TestNoteSchemaDDLGuard(t *testing.T) {
	ddl := dbnote.SchemaDDL()
	owned := dbnote.OwnedTables()
	allowed := make(map[string]bool, len(owned))
	for _, name := range owned {
		allowed[name] = true
	}
	seen := make(map[string]bool)
	for _, stmt := range ddl {
		lower := strings.ToLower(stmt)
		if !strings.HasPrefix(lower, "create table if not exists ") {
			t.Fatalf("non-CREATE-TABLE DDL is forbidden (ALTERs can drift the shared schema): %.80s", stmt)
		}
		for _, bad := range []string{"alter ", "drop ", "modify ", "change "} {
			if strings.Contains(lower, bad) {
				t.Fatalf("mutating keyword %q found in DDL: %.80s", bad, stmt)
			}
		}
		rest := strings.TrimPrefix(stmt, "create table if not exists ")
		name := rest
		if i := strings.IndexAny(rest, " \t\n("); i >= 0 {
			name = rest[:i]
		}
		if !allowed[name] {
			t.Fatalf("table %q is not in the owned-tables list", name)
		}
		seen[name] = true
	}
	for _, name := range owned {
		if !seen[name] {
			t.Fatalf("owned table %q has no DDL", name)
		}
	}
}

// Guard: quiz Migrate stays CREATE-TABLE-IF-NOT-EXISTS only and the owned
// table list stays in sync with the DDL.
func TestQuizSchemaDDLGuard(t *testing.T) {
	ddl := dbquiz.SchemaDDL()
	owned := dbquiz.OwnedTables()
	for _, stmt := range ddl {
		upper := strings.ToUpper(stmt)
		if !strings.HasPrefix(upper, "CREATE TABLE IF NOT EXISTS") {
			t.Fatalf("ddl does not start with CREATE TABLE IF NOT EXISTS: %.80s", stmt)
		}
		for _, banned := range []string{"ALTER ", "DROP ", "MODIFY ", "CHANGE "} {
			if strings.Contains(upper, banned) {
				t.Fatalf("ddl contains banned clause %q: %.120s", banned, stmt)
			}
		}
	}
	seen := map[string]bool{}
	for _, stmt := range ddl {
		upper := strings.ToUpper(stmt)
		for _, tbl := range owned {
			name := strings.ToUpper(tbl)
			if strings.Contains(upper, "CREATE TABLE IF NOT EXISTS "+name+" (") ||
				strings.Contains(upper, "CREATE TABLE IF NOT EXISTS "+name+"(") {
				seen[tbl] = true
			}
		}
	}
	for _, tbl := range owned {
		if !seen[tbl] {
			t.Errorf("owned table %q has no CREATE statement", tbl)
		}
	}
}
