package tests

import (
	"os"
	"strings"
	"testing"
)

// Guard: the MySQL repository may never run DDL and must never write anything
// except the two KG bookkeeping columns on `video`. This mirrors the service
// red lines in AGENTS.md §2.18 (app-kg = the only writer of
// kg_status/kg_version; no tables of its own, no AutoMigrate).
func TestWriteSurfaceIsPinnedToKGColumns(t *testing.T) {
	src := readPageSource(t)

	for _, banned := range []string{
		"ALTER ", "CREATE ", "DROP ", "TRUNCATE ", "INSERT ", "DELETE FROM ",
		"AutoMigrate", "CREATE TABLE",
	} {
		if strings.Contains(src, banned) {
			t.Errorf("repo/mysql must stay DDL-free and read-only except the two KG columns; found %q", banned)
		}
	}

	allowed := map[string]bool{"kg_status": true, "kg_version": true}
	updates := 0
	for offset := 0; ; {
		idx := strings.Index(src[offset:], "UPDATE ")
		if idx < 0 {
			break
		}
		start := offset + idx
		end := strings.Index(src[start:], `"`)
		if end < 0 {
			t.Fatalf("unterminated UPDATE statement near offset %d", start)
		}
		stmt := src[start : start+end]
		updates++
		if !strings.HasPrefix(stmt, "UPDATE video SET ") {
			t.Errorf("only the shared video table may be updated; got %q", stmt)
		}
		setClause := strings.TrimPrefix(stmt, "UPDATE video SET ")
		whereIdx := strings.Index(setClause, " WHERE")
		if whereIdx < 0 {
			t.Fatalf("UPDATE without WHERE guard (must be keyed): %q", stmt)
		}
		setClause = setClause[:whereIdx]
		for _, assignment := range strings.Split(setClause, ",") {
			column := strings.TrimSpace(strings.SplitN(assignment, "=", 2)[0])
			if !allowed[column] {
				t.Errorf("UPDATE writes non-KG column %q (only kg_status/kg_version are permitted)", column)
			}
		}
		offset = start + end
	}
	if updates != 2 {
		t.Errorf("expected exactly the two pinned UPDATE statements (SetStatus, MarkDone), found %d", updates)
	}
}

// readPageSource loads the MySQL repository source for structural assertions
// (no DB needed).
func readPageSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../internal/repo/mysql/page.go")
	if err != nil {
		t.Fatalf("read page.go: %v", err)
	}
	return string(b)
}
