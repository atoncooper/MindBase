package tests

import (
	. "app-sandbox/internal/db"
	"reflect"
	"testing"
)

// The service must never grow DDL for tables owned by another service: pin the
// owned table list (plan §3: exactly five sandbox_* tables).
func TestOwnedTablesAreExactlyTheSandboxTables(t *testing.T) {
	want := []string{
		"sandbox_artifact",
		"sandbox_audit",
		"sandbox_execution",
		"sandbox_lease",
		"sandbox_usage_daily",
	}
	if got := OwnedTables(); !reflect.DeepEqual(got, want) {
		t.Fatalf("owned tables drifted from plan §3:\n got: %v\nwant: %v", got, want)
	}
}

func TestMigrateTargetsExactlyTheOwnedModels(t *testing.T) {
	if len(OwnedModels) != len(OwnedTables()) {
		t.Fatalf("OwnedModels=%d tables but OwnedTables=%d: a model is missing a TableName()",
			len(OwnedModels), len(OwnedTables()))
	}
}

func TestToGormDSN(t *testing.T) {
	cases := map[string]string{
		"mysql+aiomysql://u:p@mysql:3306/mind_base": "u:p@tcp(mysql:3306)/mind_base?charset=utf8mb4&parseTime=True&loc=UTC",
		"mysql://u:p@127.0.0.1:3306/db?ssl=true":    "u:p@tcp(127.0.0.1:3306)/db?charset=utf8mb4&parseTime=True&loc=UTC",
		"u:p@tcp(h:3306)/db":                        "u:p@tcp(h:3306)/db?charset=utf8mb4&parseTime=True&loc=UTC",
	}
	for in, want := range cases {
		if got := ToGormDSN(in); got != want {
			t.Errorf("ToGormDSN(%q) = %q, want %q", in, got, want)
		}
	}
}
