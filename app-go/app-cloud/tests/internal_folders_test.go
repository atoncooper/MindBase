package tests

// HTTP-level guards for the M2M folder listing
// (GET /internal/cloud/folders?uid=&parent_id=) that app-user calls to
// provision the per-user "agent/" folder on registration. The lister is
// in-memory, so the whole contract — auth, uid/parent validation, one-level
// listing, wire shape and error mapping — runs through the real Gin middleware
// chain without a live MySQL.

import (
	"errors"
	"net/http"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/middleware"
	"app-cloud/internal/model"
	"app-cloud/internal/router"

	"github.com/gin-gonic/gin"
)

// fakeFolderList records the call arguments so the contract is asserted, not
// just the response body.
type fakeFolderList struct {
	rows      []model.CloudFolder
	err       error
	calls     int
	gotUID    int64
	gotParent *int64
}

func (f *fakeFolderList) list(uid int64, parentID *int64) ([]model.CloudFolder, error) {
	f.calls++
	f.gotUID = uid
	f.gotParent = parentID
	if f.err != nil {
		return nil, f.err
	}
	return f.rows, nil
}

// newInternalFolderEngine mounts the handler on the real internal middleware
// chain (apikey + ?uid= validation).
func newInternalFolderEngine(internalKey string, fake *fakeFolderList) *gin.Engine {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	cfg.Internal.APIKey = internalKey
	e := gin.New()
	internal := e.Group("/internal/cloud")
	internal.Use(middleware.RequireInternalKey(cfg), middleware.RequireInternalUID())
	var list router.FolderListFunc
	if fake != nil {
		list = fake.list
	}
	internal.GET("/folders", router.InternalListFolders(list))
	return e
}

func folderHeaders() map[string]string { return map[string]string{"apikey": "internal-secret"} }

func folderRows() []model.CloudFolder {
	return []model.CloudFolder{
		{ID: 11, UID: 7, Name: "agent"},
		{ID: 12, UID: 7, Name: "notes", ParentID: int64Ptr(11)},
	}
}

// ── registration on the production engine ──────────────────────────

func TestInternalFoldersRouteRegistered(t *testing.T) {
	cfg := &config.Config{}
	cfg.Internal.APIKey = "internal-secret"
	// No DB wired: the route must exist and degrade to 503, not 404/panic.
	e := router.New(router.Deps{Cfg: cfg})
	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/folders?uid=7", "", folderHeaders())
	if code != http.StatusServiceUnavailable || body["detail"] != "文件夹服务暂不可用" {
		t.Fatalf("folder listing without a DB = %d %v", code, body)
	}
}

// ── listing ─────────────────────────────────────────────────────────

func TestInternalFolderListingRoot(t *testing.T) {
	fake := &fakeFolderList{rows: folderRows()}
	e := newInternalFolderEngine("internal-secret", fake)

	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/folders?uid=7", "", folderHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if fake.gotUID != 7 || fake.gotParent != nil {
		t.Fatalf("lister args = uid %d parent %v, want root", fake.gotUID, fake.gotParent)
	}
	items, ok := body["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("items = %v, want 2 rows", body["items"])
	}
	first, _ := items[0].(map[string]any)
	if first["id"] != float64(11) || first["name"] != "agent" || first["parent_id"] != nil {
		t.Fatalf("first item = %v, want {11 agent null}", first)
	}
	second, _ := items[1].(map[string]any)
	if second["id"] != float64(12) || second["name"] != "notes" || second["parent_id"] != float64(11) {
		t.Fatalf("second item = %v, want {12 notes 11}", second)
	}
}

func TestInternalFolderListingByParent(t *testing.T) {
	fake := &fakeFolderList{rows: folderRows()[1:]}
	e := newInternalFolderEngine("internal-secret", fake)

	code, body := doJSON(t, e, http.MethodGet,
		"/internal/cloud/folders?uid=7&parent_id=11", "", folderHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if fake.gotParent == nil || *fake.gotParent != 11 {
		t.Fatalf("parent filter = %v, want 11", fake.gotParent)
	}
	items, _ := body["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["name"] != "notes" {
		t.Fatalf("items = %v", body["items"])
	}
}

func TestInternalFolderListingEmptyIsArray(t *testing.T) {
	e := newInternalFolderEngine("internal-secret", &fakeFolderList{})
	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/folders?uid=7", "", folderHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	items, ok := body["items"].([]any)
	if !ok || len(items) != 0 {
		t.Fatalf("items must be [] for an empty folder, got %v", body["items"])
	}
}

// ── auth / validation / errors ─────────────────────────────────────

func TestInternalFolderListingValidation(t *testing.T) {
	fake := &fakeFolderList{}
	e := newInternalFolderEngine("internal-secret", fake)

	cases := []struct {
		name   string
		target string
		key    string
		want   int
	}{
		{"missing apikey", "/internal/cloud/folders?uid=7", "", http.StatusUnauthorized},
		{"wrong apikey", "/internal/cloud/folders?uid=7", "wrong", http.StatusUnauthorized},
		{"missing uid", "/internal/cloud/folders", "internal-secret", http.StatusUnprocessableEntity},
		{"invalid uid", "/internal/cloud/folders?uid=abc", "internal-secret", http.StatusUnprocessableEntity},
		{"invalid parent", "/internal/cloud/folders?uid=7&parent_id=abc", "internal-secret", http.StatusUnprocessableEntity},
		{"zero parent", "/internal/cloud/folders?uid=7&parent_id=0", "internal-secret", http.StatusUnprocessableEntity},
		{"negative parent", "/internal/cloud/folders?uid=7&parent_id=-3", "internal-secret", http.StatusUnprocessableEntity},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string]string{}
			if tc.key != "" {
				headers["apikey"] = tc.key
			}
			code, _ := doJSON(t, e, http.MethodGet, tc.target, "", headers)
			if code != tc.want {
				t.Fatalf("%s = %d, want %d", tc.name, code, tc.want)
			}
		})
	}
	if fake.calls != 0 {
		t.Fatalf("lister must not run before validation, calls = %d", fake.calls)
	}

	// Unconfigured key fails closed like every other internal endpoint.
	noKey := newInternalFolderEngine("", &fakeFolderList{})
	if code, _ := doJSON(t, noKey, http.MethodGet, "/internal/cloud/folders?uid=7", "", folderHeaders()); code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured internal key must be 503, got %d", code)
	}
}

func TestInternalFolderListingStoreError(t *testing.T) {
	fake := &fakeFolderList{err: errors.New("db down")}
	e := newInternalFolderEngine("internal-secret", fake)
	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/folders?uid=7", "", folderHeaders())
	if code != http.StatusInternalServerError || body["detail"] != "服务异常，请稍后重试" {
		t.Fatalf("store error = %d %v", code, body)
	}
}
