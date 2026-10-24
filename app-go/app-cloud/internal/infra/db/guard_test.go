package db

import (
	"os"
	"strings"
	"testing"
)

func allowMap() map[string]bool {
	allowed := make(map[string]bool, len(ownedTables))
	for _, name := range ownedTables {
		allowed[name] = true
	}
	return allowed
}

// Guard: Migrate's CREATE phase may only issue DDL against tables app-cloud
// owns. Every CREATE statement must start with "create table if not exists
// <name>" where <name> is in ownedTables. Any drift (ALTER/DROP/new table)
// fails here before it can damage the shared bilirag database.
func TestSchemaDDLOnlyTouchesOwnedTables(t *testing.T) {
	allowed := allowMap()
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

// Guard (plan/1.0.16 §3.1, Lead-approved): the ONLY mutating DDL app-cloud may
// ever issue is this exact pinned ALTER whitelist — share contract/disclosure
// columns + one index
// on app-cloud's own cloud_shares table, each applied idempotently via
// ensureShareColumns (probe information_schema, add only when missing).
// Adding/removing one entry here is a contract event: update this literal, the
// mirrored CREATE-TABLE DDL in db.go, and the plan in lockstep. NOTHING ELSE
// may ever ALTER a shared table — not for other tables, not for other columns.
var pinnedShareAlterWhitelist = []string{
	"alter table cloud_shares add column target_type varchar(10) not null default 'file'",
	"alter table cloud_shares add column folder_id int null",
	"alter table cloud_shares add column legal_ack tinyint(1) not null default 0",
	"alter table cloud_shares add column content_review_ack tinyint(1) not null default 0",
	"alter table cloud_shares add column content_review_policy_version varchar(32) null",
	"alter table cloud_shares add column content_review_ack_at datetime null",
	"alter table cloud_shares add column moderation_status varchar(10) not null default 'active'",
	"alter table cloud_shares add column moderation_reason varchar(500) null",
	"alter table cloud_shares add column moderation_time datetime null",
	"alter table cloud_shares add column moderation_by varchar(64) null",
	shareIndexDDL,
}

func TestShareAlterWhitelistPinned(t *testing.T) {
	var got []string
	for _, alt := range shareColumnAlters() {
		got = append(got, alt.ddl)
	}
	got = append(got, shareIndexDDL)
	if len(got) != len(pinnedShareAlterWhitelist) {
		t.Fatalf("ALTER set changed: got %d statements, whitelist has %d — update the pinned whitelist", len(got), len(pinnedShareAlterWhitelist))
	}
	for i, want := range pinnedShareAlterWhitelist {
		if got[i] != want {
			t.Fatalf("ALTER %d drifted:\n got: %s\nwant: %s", i, got[i], want)
		}
	}
}

// Guard: every pinned ALTER targets cloud_shares and only ADDs a column or
// index — no drop/modify/change may ever sneak into the whitelist.
func TestShareAlterWhitelistShape(t *testing.T) {
	for _, ddl := range pinnedShareAlterWhitelist {
		if !strings.HasPrefix(ddl, "alter table cloud_shares add ") {
			t.Fatalf("pinned ALTER outside 'alter table cloud_shares add': %s", ddl)
		}
	}
}

// Runtime guard (graceful skip): against a REAL MySQL (set
// APPCLOUD_TEST_MYSQL_DSN, e.g.
// root:pass@tcp(127.0.0.1:3306)/bilirag_test) Migrate must be re-runnable:
// fresh run creates the schema, second run is a no-op (the pinned ALTERs
// only fire when information_schema still shows the column missing).
func TestMigrateIdempotentAgainstRealMySQL(t *testing.T) {
	dsn := os.Getenv("APPCLOUD_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("APPCLOUD_TEST_MYSQL_DSN not set — runtime migration guard needs a disposable MySQL")
	}
	if err := Init(dsn, 2, 2, 60, false); err != nil {
		t.Skipf("test MySQL unreachable (%v) — graceful skip", err)
	}
	defer Close()
	for pass := 1; pass <= 2; pass++ {
		if err := Migrate(); err != nil {
			t.Fatalf("Migrate pass %d failed: %v", pass, err)
		}
	}
	for _, alt := range shareColumnAlters() {
		var n int64
		if err := DB.Raw(
			"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cloud_shares' AND column_name = ?",
			alt.column).Scan(&n).Error; err != nil {
			t.Fatalf("probe %s: %v", alt.column, err)
		}
		if n != 1 {
			t.Fatalf("column %s missing after two Migrate passes", alt.column)
		}
	}
	var in int64
	if err := DB.Raw(
		"SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cloud_shares' AND index_name = ?",
		shareIndexName).Scan(&in).Error; err != nil {
		t.Fatalf("probe index: %v", err)
	}
	if in == 0 {
		t.Fatal("index idx_cloud_shares_moderation missing after two Migrate passes")
	}
}
