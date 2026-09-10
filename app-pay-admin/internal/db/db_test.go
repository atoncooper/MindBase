// Guard test: the admin's Migrate must ONLY create payadmin_user. The pay_*
// tables are owned by app-pay (Java, schema.sql) — if this test ever fails a
// pay_* model leaked into Migrate and the Java schema is at risk of drift.
package db

import (
	"testing"

	"app-pay-admin/internal/model"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestMigrateOnlyCreatesAdminTables(t *testing.T) {
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	old := DB
	DB = gdb
	defer func() { DB = old }()

	if err := Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if !gdb.Migrator().HasTable(&model.PayAdminUser{}) {
		t.Fatal("payadmin_user should be created by Migrate")
	}
	for _, forbidden := range []string{"pay_order", "pay_membership", "pay_membership_event", "pay_callback_log", "pay_product"} {
		if gdb.Migrator().HasTable(forbidden) {
			t.Fatalf("Migrate must never create %s (owned by app-pay)", forbidden)
		}
	}
}

func TestToGormDSN(t *testing.T) {
	cases := []struct{ in, want string }{
		{
			"mysql+aiomysql://app_pay:pw@app-pay-mysql:3306/app_pay",
			"app_pay:pw@tcp(app-pay-mysql:3306)/app_pay?charset=utf8mb4&parseTime=True&loc=Local",
		},
		{
			"mysql+pymysql://u:p@127.0.0.1:3307/app_pay?extra=1",
			"u:p@tcp(127.0.0.1:3307)/app_pay?charset=utf8mb4&parseTime=True&loc=Local",
		},
	}
	for _, tc := range cases {
		if got := toGormDSN(tc.in); got != tc.want {
			t.Fatalf("toGormDSN(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
