package tests

// Black-box guards for the registration-time "agent/" drive folder provisioning:
// app-user lists/creates folders through app-cloud's M2M face
// (GET/POST /internal/cloud/folders). Everything runs against an httptest fake
// app-cloud, so the HTTP contract and the best-effort behaviour are asserted
// without a live cloud service. The end-to-end registration case (real MySQL,
// skipped unless APPUSER_TEST_MYSQL_DSN is set) pins the funnel itself.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"app-user/internal/config"
	foldercloud "app-user/internal/infra/cloud"
	authdb "app-user/internal/infra/db/auth"
	appmysql "app-user/internal/infra/mysql"
	"app-user/internal/infra/security"
	authservice "app-user/internal/service/auth"
)

// fakeCloudDrive is an in-memory stand-in for app-cloud's /internal/cloud
// folder face. It records the wire details (uid query, apikey, X-Uid, POST
// body) so the client contract is asserted, not just the outcome.
type fakeCloudDrive struct {
	mu sync.Mutex

	items        []map[string]any
	listStatus   int
	createStatus int

	listCalls   int
	createCalls int
	lastCreate  map[string]any
	lastUID     string
	lastAPIKey  string
	lastXUID    string
}

func (f *fakeCloudDrive) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/cloud/folders" {
			http.NotFound(w, r)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lastUID = r.URL.Query().Get("uid")
		f.lastAPIKey = r.Header.Get("apikey")
		f.lastXUID = r.Header.Get("X-Uid")
		switch r.Method {
		case http.MethodGet:
			f.listCalls++
			if f.listStatus != 0 {
				w.WriteHeader(f.listStatus)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"items": f.items})
		case http.MethodPost:
			f.createCalls++
			if f.createStatus != 0 {
				w.WriteHeader(f.createStatus)
				return
			}
			f.lastCreate = map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&f.lastCreate)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 99, "name": f.lastCreate["name"], "parent_id": nil,
			})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func newFakeCloudDrive(t *testing.T) (*fakeCloudDrive, *httptest.Server) {
	t.Helper()
	drive := &fakeCloudDrive{}
	srv := httptest.NewServer(drive.handler())
	t.Cleanup(srv.Close)
	return drive, srv
}

// ── client contract ────────────────────────────────────────────────

func TestEnsureFolderCreatesMissingAgentFolder(t *testing.T) {
	drive, srv := newFakeCloudDrive(t)
	client := foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second)

	if err := client.EnsureFolder(context.Background(), 42, "agent"); err != nil {
		t.Fatalf("ensure folder: %v", err)
	}
	if drive.listCalls != 1 || drive.createCalls != 1 {
		t.Fatalf("calls = list %d create %d, want 1/1", drive.listCalls, drive.createCalls)
	}
	if drive.lastUID != "42" {
		t.Fatalf("uid query = %q, want 42", drive.lastUID)
	}
	if drive.lastAPIKey != "internal-secret" || drive.lastXUID != "42" {
		t.Fatalf("headers = apikey %q X-Uid %q", drive.lastAPIKey, drive.lastXUID)
	}
	if drive.lastCreate["name"] != "agent" {
		t.Fatalf("create body = %v, want name=agent", drive.lastCreate)
	}
	// A root folder must not carry parentId: omitted means root on the server.
	if _, ok := drive.lastCreate["parentId"]; ok {
		t.Fatalf("root create must not send parentId: %v", drive.lastCreate)
	}
}

func TestEnsureFolderSkipsExistingFolderCaseInsensitive(t *testing.T) {
	drive, srv := newFakeCloudDrive(t)
	drive.items = []map[string]any{
		{"id": 7, "name": "Agent", "parent_id": nil},
		{"id": 8, "name": "notes", "parent_id": nil},
	}
	client := foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second)

	if err := client.EnsureFolder(context.Background(), 42, "agent"); err != nil {
		t.Fatalf("ensure folder: %v", err)
	}
	if drive.listCalls != 1 || drive.createCalls != 0 {
		t.Fatalf("calls = list %d create %d, want 1/0 (no duplicate)", drive.listCalls, drive.createCalls)
	}
}

func TestEnsureFolderPropagatesCloudFailures(t *testing.T) {
	t.Run("list 500", func(t *testing.T) {
		drive, srv := newFakeCloudDrive(t)
		drive.listStatus = http.StatusInternalServerError
		client := foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second)
		if err := client.EnsureFolder(context.Background(), 42, "agent"); err == nil {
			t.Fatal("list 500 must return an error")
		}
		if drive.createCalls != 0 {
			t.Fatalf("must not create after a failed list, create calls = %d", drive.createCalls)
		}
	})
	t.Run("create 500", func(t *testing.T) {
		drive, srv := newFakeCloudDrive(t)
		drive.createStatus = http.StatusInternalServerError
		client := foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second)
		if err := client.EnsureFolder(context.Background(), 42, "agent"); err == nil {
			t.Fatal("create 500 must return an error")
		}
	})
	t.Run("disabled client", func(t *testing.T) {
		client := foldercloud.NewFolderClient("", "", time.Second)
		if client.Enabled() {
			t.Fatal("empty base_url/api_key must disable the client")
		}
		if err := client.EnsureFolder(context.Background(), 42, "agent"); err == nil {
			t.Fatal("disabled client must return an error")
		}
	})
}

// ── registration funnel ────────────────────────────────────────────

// recordingEnsurer captures what the registration hook asks for and can fail
// like an app-cloud outage.
type recordingEnsurer struct {
	calls  int
	uid    int64
	name   string
	err    error
	hasDdl bool
	ttl    time.Duration
}

func (r *recordingEnsurer) EnsureFolder(ctx context.Context, uid int64, name string) error {
	r.calls++
	r.uid, r.name = uid, name
	if deadline, ok := ctx.Deadline(); ok {
		r.hasDdl = true
		r.ttl = time.Until(deadline)
	}
	return r.err
}

func newTestAuthService() *authservice.AuthService {
	// nil DB is fine: the registration hook only touches the ensurer.
	return authservice.NewAuthService(nil, &config.AuthConfig{}, nil, nil, nil,
		authservice.NewRBACService(nil), nil, nil)
}

func TestRegistrationHookProvisionsAgentFolder(t *testing.T) {
	rec := &recordingEnsurer{}
	svc := newTestAuthService()
	svc.SetDriveFolderEnsurer(rec)

	svc.EnsureDefaultDriveFolder(7)

	if rec.calls != 1 || rec.uid != 7 || rec.name != "agent" {
		t.Fatalf("hook called %d times with uid %d name %q, want 1/7/agent", rec.calls, rec.uid, rec.name)
	}
	if !rec.hasDdl || rec.ttl <= 0 || rec.ttl > 3*time.Second {
		t.Fatalf("provisioning must carry a ≤3s deadline, got deadline=%v ttl=%v", rec.hasDdl, rec.ttl)
	}
}

func TestRegistrationSurvivesCloudOutage(t *testing.T) {
	// A failing app-cloud must not propagate: the hook has no error return and
	// never blocks the caller beyond the 3s bound.
	rec := &recordingEnsurer{err: errors.New("app-cloud 500")}
	svc := newTestAuthService()
	svc.SetDriveFolderEnsurer(rec)

	start := time.Now()
	svc.EnsureDefaultDriveFolder(7) // must not panic
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("best-effort provisioning blocked for %v", elapsed)
	}
	if rec.calls != 1 {
		t.Fatalf("hook calls = %d, want 1", rec.calls)
	}

	// A nil ensurer (feature disabled) is a silent no-op.
	newTestAuthService().EnsureDefaultDriveFolder(7)
}

func TestRegistrationHookUsesFolderClientAgainstCloud500(t *testing.T) {
	drive, srv := newFakeCloudDrive(t)
	drive.listStatus = http.StatusInternalServerError
	svc := newTestAuthService()
	svc.SetDriveFolderEnsurer(foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second))

	svc.EnsureDefaultDriveFolder(42) // must swallow the 500 and return
	if drive.listCalls != 1 {
		t.Fatalf("folder list calls = %d, want 1", drive.listCalls)
	}
}

// ── end-to-end registration (real MySQL) ───────────────────────────

// TestRegisterEmailProvisionsAgentFolder exercises the real registration funnel
// (users row → default role → folder provisioning → token) against MySQL. It is
// skipped unless APPUSER_TEST_MYSQL_DSN is set, e.g.:
//
//	APPUSER_TEST_MYSQL_DSN='mysql://mind_base:mind-base@127.0.0.1:3306/mind_base' //	  go test ./tests -run TestRegisterEmailProvisionsAgentFolder -v
//
// It creates and removes unique throwaway users; do not point it at a database
// whose schema you cannot migrate.
func TestRegisterEmailProvisionsAgentFolder(t *testing.T) {
	dsn := os.Getenv("APPUSER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("APPUSER_TEST_MYSQL_DSN not set; skipping MySQL integration test")
	}
	db, err := appmysql.Init(dsn, 5, 2, 60, 0, false)
	if err != nil {
		t.Fatalf("connect mysql: %v", err)
	}
	defer func() { _ = appmysql.Close(db) }()
	authdb.Use(db)
	if err := authdb.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cipher, err := security.NewCipher("")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	snow, err := security.NewSnowflake(2)
	if err != nil {
		t.Fatalf("snowflake: %v", err)
	}
	rbacSvc := authservice.NewRBACService(db)
	if err := rbacSvc.SeedDefaults(); err != nil {
		t.Fatalf("seed rbac: %v", err)
	}
	svc := authservice.NewAuthService(db, &config.AuthConfig{}, cipher, snow,
		authservice.NewTokenService(db, 7, nil), rbacSvc, nil, nil)

	drive, srv := newFakeCloudDrive(t)
	svc.SetDriveFolderEnsurer(foldercloud.NewFolderClient(srv.URL, "internal-secret", 2*time.Second))

	cleanup := func(uid int64) {
		_ = db.Exec("DELETE FROM user_tokens WHERE uid = ?", uid).Error
		_ = db.Exec("DELETE FROM rbac_user_role WHERE uid = ?", uid).Error
		_ = db.Exec("DELETE FROM user_profile WHERE uid = ?", uid).Error
		_ = db.Exec("DELETE FROM users WHERE uid = ?", uid).Error
	}

	// Healthy cloud: registration creates the agent folder for the new uid.
	email := fmt.Sprintf("folder-provision-%d@example.com", time.Now().UnixNano())
	uid, token, err := svc.RegisterWithEmail(email, "Passw0rd123", nil, nil, nil)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer cleanup(uid)
	if token == "" || uid <= 0 {
		t.Fatalf("registration returned uid %d token %q", uid, token)
	}
	if drive.createCalls != 1 || drive.lastUID != strconv.FormatInt(uid, 10) {
		t.Fatalf("folder provisioning = create %d uid %q, want 1/%d", drive.createCalls, drive.lastUID, uid)
	}

	// Cloud outage: registration must still succeed (best-effort hook).
	drive.mu.Lock()
	drive.listStatus = http.StatusInternalServerError
	drive.mu.Unlock()
	email = fmt.Sprintf("folder-outage-%d@example.com", time.Now().UnixNano())
	uid2, token2, err := svc.RegisterWithEmail(email, "Passw0rd123", nil, nil, nil)
	if err != nil {
		t.Fatalf("registration must survive an app-cloud outage: %v", err)
	}
	defer cleanup(uid2)
	if token2 == "" || uid2 <= 0 {
		t.Fatalf("registration under outage returned uid %d token %q", uid2, token2)
	}
}
