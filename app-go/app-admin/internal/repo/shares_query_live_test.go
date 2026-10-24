package repo

// Live-DB integration checks for the admin read queries. These are the queries
// that only break against a real MySQL (missing comma in the projection, wrong
// column alias for a scan target, recursive-CTE shape). CI has no MySQL, so the
// test SKIPS unless APPADMIN_TEST_DSN points at a dev/shared database:
//
//	APPADMIN_TEST_DSN='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base' go test ./internal/repo/
//
// It is read-only: no writes, no migrations.

import (
	"os"
	"testing"

	"app-admin/internal/db"
)

func TestLiveShareQueries(t *testing.T) {
	dsn := os.Getenv("APPADMIN_TEST_DSN")
	if dsn == "" {
		t.Skip("APPADMIN_TEST_DSN not set; skipping live MySQL integration test")
	}
	if err := db.Init(dsn, 4, 2, 60, false); err != nil {
		t.Fatalf("db.Init: %v", err)
	}
	defer func() { _ = db.Close() }()

	rows, total, err := ListShares(ShareFilters{Limit: 20, Offset: 0})
	if err != nil {
		t.Fatalf("ListShares: %v", err)
	}
	if total < 0 {
		t.Fatalf("ListShares total = %d", total)
	}
	for i := range rows {
		if rows[i].ID <= 0 {
			t.Fatalf("row %d has no id: %+v", i, rows[i])
		}
		if rows[i].TargetType == "" {
			t.Fatalf("row %d target_type empty (COALESCE alias broken)", i)
		}
		// File shares must resolve a display name (file_name alias mapping).
		if rows[i].TargetType == "file" && rows[i].Name() == "" {
			t.Fatalf("file share %d has empty name (file_name scan mapping broken)", rows[i].ID)
		}
	}

	// Target-availability filter: the review queue must exclude shares whose
	// target file/folder was soft-deleted, while the dead-target view returns
	// only those legacy rows.
	yes, no := true, false
	availableRows, availableTotal, err := ListShares(ShareFilters{Available: &yes, Limit: 50})
	if err != nil {
		t.Fatalf("ListShares(available=true): %v", err)
	}
	if availableTotal > total {
		t.Fatalf("available total %d > all total %d", availableTotal, total)
	}
	for i := range availableRows {
		if !availableRows[i].TargetAvailable {
			t.Fatalf("available filter returned dead target share %d", availableRows[i].ID)
		}
	}
	deadRows, _, err := ListShares(ShareFilters{Available: &no, Limit: 50})
	if err != nil {
		t.Fatalf("ListShares(available=false): %v", err)
	}
	for i := range deadRows {
		if deadRows[i].TargetAvailable {
			t.Fatalf("dead-target filter returned live share %d", deadRows[i].ID)
		}
	}

	// Detail projection must scan (column list / comma placement).
	if len(rows) > 0 {
		share, err := GetShare(rows[0].ID)
		if err != nil {
			t.Fatalf("GetShare(%d): %v", rows[0].ID, err)
		}
		if share == nil {
			t.Fatalf("GetShare(%d) = nil", rows[0].ID)
		}
	}

	// Folder aggregation + file listing against real rows, when a folder share exists.
	for i := range rows {
		if rows[i].TargetType != "folder" || rows[i].FolderID == nil || *rows[i].FolderID <= 0 {
			continue
		}
		agg, err := FolderAggregates([]int64{*rows[i].FolderID})
		if err != nil {
			t.Fatalf("FolderAggregates: %v", err)
		}
		if a, ok := agg[*rows[i].FolderID]; !ok || a.Count < 0 {
			t.Fatalf("FolderAggregates missing/invalid root %d: %+v", *rows[i].FolderID, agg)
		}
		files, _, err := FolderFiles(*rows[i].FolderID)
		if err != nil {
			t.Fatalf("FolderFiles: %v", err)
		}
		for j := range files {
			if files[j].Name == "" {
				t.Fatalf("folder file %d has empty name (original_name alias mapping broken)", j)
			}
		}
		break
	}

	users, _, err := ListUsers(UserQuery{}, 10, 0)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	for _, u := range users {
		if u.UID <= 0 {
			t.Fatalf("user row without uid: %+v", u)
		}
	}

	if _, _, err := ListAudits("", "", 10, 0); err != nil {
		t.Fatalf("ListAudits: %v", err)
	}
}
