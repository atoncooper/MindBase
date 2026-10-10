package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app-note/internal/config"
	"app-note/internal/model"
	"app-note/internal/repo"
	"app-note/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// routerFake implements service.ContentStore in memory (test-only).
// failWrite=true makes writes return the disabled-mode error (503 path).
type routerFake struct {
	contents  map[string]string
	failWrite bool
}

func (f *routerFake) UpsertContent(_ context.Context, noteUUID string, _ int64, md string) (string, error) {
	if f.failWrite {
		return "", repo.ErrContentDisabled
	}
	f.contents[noteUUID] = md
	return "doc-" + noteUUID, nil
}

func (f *routerFake) GetContent(_ context.Context, noteUUID string) (*repo.NoteContent, error) {
	if md, ok := f.contents[noteUUID]; ok {
		return &repo.NoteContent{NoteUUID: noteUUID, ContentMD: md}, nil
	}
	return nil, nil
}

func (f *routerFake) DeleteContent(_ context.Context, noteUUID string) (int64, error) {
	if _, ok := f.contents[noteUUID]; ok {
		delete(f.contents, noteUUID)
		return 1, nil
	}
	return 0, nil
}

func (f *routerFake) InsertRevision(_ context.Context, _, _ string, _ *string) (string, error) {
	return "rev-1", nil
}

func (f *routerFake) ListRevisions(_ context.Context, _ string, _ int) ([]repo.RevisionMeta, error) {
	return nil, nil
}

func (f *routerFake) GetRevision(_ context.Context, _ string) (*repo.RevisionFull, error) {
	return nil, nil
}

func newTestRouter(t *testing.T) (*gin.Engine, *routerFake) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Note{}, &model.NoteAnchor{}, &model.NoteShare{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	fake := &routerFake{contents: map[string]string{}}
	svc := service.NewNoteService(repo.NewNoteRepo(), fake)
	e := New(Deps{Cfg: &config.Config{}, DB: db, Notes: svc})
	return e, fake
}

// Mongo disabled → create maps the storage error to 503 with a friendly
// detail (never the raw driver text).
func TestCreateStorageUnavailable(t *testing.T) {
	e, fake := newTestRouter(t)
	fake.failWrite = true
	rec, parsed := doJSON(t, e, http.MethodPost, "/notes", "1", map[string]any{
		"title": "n1", "target_type": "video", "target_id": "BV1:1", "content_md": "x",
	}, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%v)", rec.Code, parsed)
	}
	if detail, _ := parsed["detail"].(string); strings.Contains(detail, "mongo") {
		t.Fatalf("internal error leaked: %q", detail)
	}
}

func doJSON(t *testing.T, e *gin.Engine, method, path, uid string, body any, headers map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if uid != "" {
		req.Header.Set("X-Uid", uid)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	var parsed map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	return rec, parsed
}

// The route-collision risk: /notes/shared/:token (public) coexisting with
// /notes/:note_uuid. Gin must serve the static segment with priority and
// NOT panic at registration time.
func TestSharedRouteWinsOverParamRoute(t *testing.T) {
	e, _ := newTestRouter(t)

	// Unknown token → the shared handler runs (404 with the share message,
	// NOT the note-not-found message).
	rec, parsed := doJSON(t, e, http.MethodGet, "/notes/shared/nope", "", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if detail, _ := parsed["detail"].(string); !strings.Contains(detail, "分享不存在") {
		t.Fatalf("detail = %v (shared handler did not run)", parsed["detail"])
	}

	// A param-shaped uuid still resolves to the note handler (401 without
	// X-Uid proves the protected handler ran).
	rec, _ = doJSON(t, e, http.MethodGet, "/notes/some-uuid", "", nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 from protected note handler, got %d", rec.Code)
	}
}

func TestProtectedEndpointsRequireXUid(t *testing.T) {
	e, _ := newTestRouter(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/notes"},
		{http.MethodPost, "/notes"},
		{http.MethodGet, "/notes/abc"},
		{http.MethodDelete, "/notes/abc"},
		{http.MethodGet, "/internal/note/notes"},
	} {
		rec, _ := doJSON(t, e, tc.method, tc.path, "", nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without X-Uid = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

func TestCreateListFlow(t *testing.T) {
	e, _ := newTestRouter(t)
	rec, created := doJSON(t, e, http.MethodPost, "/notes", "1", map[string]any{
		"title": "n1", "target_type": "video", "target_id": "BV1:1", "content_md": "# hi",
	}, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d: %v", rec.Code, created)
	}
	uuid, _ := created["uuid"].(string)
	if uuid == "" {
		t.Fatalf("missing uuid in %v", created)
	}
	// naive-UTC updated_at shape (no 'Z' suffix) — If-Match round-trip
	// depends on it.
	if ua, _ := created["updated_at"].(string); strings.HasSuffix(ua, "Z") || strings.Contains(ua, "+") {
		t.Fatalf("updated_at format drifted: %q", ua)
	}

	rec, parsed := doJSON(t, e, http.MethodGet, "/notes?page=1&page_size=20", "1", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d", rec.Code)
	}
	if got := rec.Header().Get("X-Total-Count"); got != "1" {
		t.Fatalf("X-Total-Count = %q", got)
	}
	if expose := rec.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(expose, "X-Total-Count") {
		t.Fatalf("expose headers = %q", expose)
	}
	if arr, ok := parsed["detail"]; ok {
		t.Fatalf("list should return an array, got %v", arr)
	}
	// Cross-user isolation.
	rec, _ = doJSON(t, e, http.MethodGet, "/notes", "2", nil, nil)
	if got := rec.Header().Get("X-Total-Count"); got != "0" {
		t.Fatalf("cross-user X-Total-Count = %q", got)
	}
}

func TestUpdateConflictBody(t *testing.T) {
	e, _ := newTestRouter(t)
	_, created := doJSON(t, e, http.MethodPost, "/notes", "1", map[string]any{
		"title": "n1", "target_type": "video", "target_id": "BV1:1", "content_md": "v1",
	}, nil)
	ua, _ := created["updated_at"].(string)

	// Stale If-Match → 409 with the structured nested detail.
	stale := time.Time{}
	if ts, err := service.ParseUTC(ua); err == nil {
		stale = ts.Add(-time.Minute)
	}
	rec, parsed := doJSON(t, e, http.MethodPatch, "/notes/"+created["uuid"].(string), "1",
		map[string]any{"content_md": "v2"},
		map[string]string{"If-Match": stale.UTC().Format("2006-01-02T15:04:05.999999")})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflict = %d: %v", rec.Code, parsed)
	}
	detail, _ := parsed["detail"].(map[string]any)
	if detail == nil || detail["error"] != "conflict" || detail["note_uuid"] == "" {
		t.Fatalf("409 detail shape drifted: %v", parsed["detail"])
	}

	// Fresh If-Match → 200.
	rec, parsed = doJSON(t, e, http.MethodPatch, "/notes/"+created["uuid"].(string), "1",
		map[string]any{"content_md": "v2"},
		map[string]string{"If-Match": ua})
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh If-Match = %d: %v", rec.Code, parsed)
	}
	if parsed["content_md"] != "v2" {
		t.Fatalf("content = %v", parsed["content_md"])
	}
}

func TestDeleteNoContent(t *testing.T) {
	e, _ := newTestRouter(t)
	_, created := doJSON(t, e, http.MethodPost, "/notes", "1", map[string]any{
		"title": "n1", "target_type": "video", "target_id": "BV1:1", "content_md": "x",
	}, nil)
	rec, _ := doJSON(t, e, http.MethodDelete, "/notes/"+created["uuid"].(string), "1", nil, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", rec.Code)
	}
	rec, parsed := doJSON(t, e, http.MethodGet, "/notes/"+created["uuid"].(string), "1", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete = %d (%v)", rec.Code, parsed["detail"])
	}
	if detail, _ := parsed["detail"].(string); detail != "笔记不存在" {
		t.Fatalf("detail = %v", parsed["detail"])
	}
}

func TestHealth(t *testing.T) {
	e, _ := newTestRouter(t)
	rec, _ := doJSON(t, e, http.MethodGet, "/health", "", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d", rec.Code)
	}
}

// Compile-time sanity: the wire timestamp helper must not emit a zone suffix.
func TestNaiveUTCJSON(t *testing.T) {
	b, _ := json.Marshal(service.NaiveUTC{Time: time.Date(2026, 10, 4, 12, 34, 56, 789012000, time.UTC)})
	if string(b) != `"2026-10-04T12:34:56.789012"` {
		t.Fatalf("got %s", b)
	}
	b, _ = json.Marshal(service.NaiveUTC{Time: time.Date(2026, 10, 4, 12, 34, 56, 0, time.UTC)})
	if string(b) != `"2026-10-04T12:34:56"` {
		t.Fatalf("got %s", b)
	}
	_ = fmt.Sprint()
}

// Unknown paths answer with the JSON {"detail": ...} error shape (parity
// with the FastAPI bodies the frontend parses), not gin's empty 404.
func TestNoRouteJSONDetail(t *testing.T) {
	e, _ := newTestRouter(t)
	rec, parsed := doJSON(t, e, http.MethodGet, "/definitely-not-a-route", "", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if detail, _ := parsed["detail"].(string); detail == "" {
		t.Fatalf("expected JSON detail, got %v", parsed)
	}
}
