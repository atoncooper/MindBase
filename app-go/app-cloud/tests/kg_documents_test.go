package tests

// HTTP-level guards for the KG cloud-document M2M reads
// (GET /internal/cloud/kg/documents and /internal/cloud/kg/document): auth,
// parameter validation, cursor/limit semantics, truncation and wire shape.
// The handlers take a KGDocumentReader, so no live MongoDB (or any other
// backing service) is needed — the whole contract is exercised through the
// real Gin middleware chain.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/middleware"
	"app-cloud/internal/router"

	"github.com/gin-gonic/gin"
)

// fakeKGReader is an in-memory KGDocumentReader (records the arguments so the
// cursor/limit contract is asserted, not just the response body).
type fakeKGReader struct {
	metas []mongostore.ParsedDocumentMeta
	doc   *mongostore.ParsedDocument

	listErr error
	getErr  error

	calls     int
	gotUID    int64
	gotCursor string
	gotLimit  int
	gotUUID   string
}

func (f *fakeKGReader) ListParsedDocuments(_ context.Context, uid int64, afterUploadUUID string,
	limit int) ([]mongostore.ParsedDocumentMeta, error) {
	f.calls++
	f.gotUID, f.gotCursor, f.gotLimit = uid, afterUploadUUID, limit
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.metas, nil
}

func (f *fakeKGReader) GetParsedDocument(_ context.Context, uid int64,
	uploadUUID string) (*mongostore.ParsedDocument, error) {
	f.calls++
	f.gotUID, f.gotUUID = uid, uploadUUID
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.doc, nil
}

// newKGEngine mounts the two KG handlers on the real /internal/cloud middleware
// chain (apikey + uid validation) without booting the rest of the service.
func newKGEngine(internalKey string, reader router.KGDocumentReader) *gin.Engine {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	cfg.Internal.APIKey = internalKey
	e := gin.New()
	internal := e.Group("/internal/cloud")
	internal.Use(middleware.RequireInternalKey(cfg), middleware.RequireInternalUID())
	internal.GET("/kg/documents", router.KGDocumentsHandler(reader))
	internal.GET("/kg/document", router.KGDocumentHandler(reader))
	return e
}

func kgHeaders() map[string]string { return map[string]string{"apikey": "internal-secret"} }

// ── registration on the production engine ──────────────────────────

func TestKGDocumentsRoutesRegistered(t *testing.T) {
	cfg := &config.Config{}
	cfg.Internal.APIKey = "internal-secret"
	e := router.New(router.Deps{Cfg: cfg}) // nil-safe Mongo store → empty page / 404

	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", kgHeaders())
	if code != http.StatusOK {
		t.Fatalf("list status = %d, body = %v", code, body)
	}
	assertKeys(t, body, "items", "next_cursor")
	if items, ok := body["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("items must be [] with a disabled store: %v", body["items"])
	}
	if body["next_cursor"] != nil {
		t.Fatalf("next_cursor must be null for an empty page: %v", body["next_cursor"])
	}

	code, body = doJSON(t, e, http.MethodGet, "/internal/cloud/kg/document?uid=7", "", kgHeaders())
	if code != http.StatusUnprocessableEntity || body["detail"] != "缺少 upload_uuid 参数" {
		t.Fatalf("missing upload_uuid = %d %v", code, body)
	}

	code, body = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=u1", "", kgHeaders())
	if code != http.StatusNotFound || body["detail"] != "Document not found" {
		t.Fatalf("unknown document with a disabled store = %d %v", code, body)
	}
}

func TestKGDocumentsAuthAndUIDValidation(t *testing.T) {
	// Unconfigured key fails closed before any credential comparison.
	noKey := newKGEngine("", &fakeKGReader{})
	if code, _ := doJSON(t, noKey, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured internal key must be 503, got %d", code)
	}

	reader := &fakeKGReader{}
	e := newKGEngine("internal-secret", reader)
	if code, _ := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing apikey must be 401, got %d", code)
	}
	if code, _ := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "",
		map[string]string{"apikey": "wrong"}); code != http.StatusUnauthorized {
		t.Fatalf("wrong apikey must be 401, got %d", code)
	}
	if code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents", "",
		kgHeaders()); code != http.StatusUnprocessableEntity || body["detail"] != "缺少 uid 参数" {
		t.Fatalf("missing uid must be 422, got %d %v", code, body)
	}
	if code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=abc", "",
		kgHeaders()); code != http.StatusUnprocessableEntity || body["detail"] != "uid 不合法" {
		t.Fatalf("invalid uid must be 422, got %d %v", code, body)
	}
	if reader.calls != 0 {
		t.Fatalf("handlers must not run before auth/uid validation, calls = %d", reader.calls)
	}
	// Bearer form is accepted like the other internal endpoints.
	bearer := map[string]string{"Authorization": "Bearer internal-secret"}
	if code, _ := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", bearer); code != http.StatusOK {
		t.Fatalf("Bearer apikey must pass, got %d", code)
	}
}

// ── listing ─────────────────────────────────────────────────────────

func TestKGDocumentsListingPagination(t *testing.T) {
	metas := make([]mongostore.ParsedDocumentMeta, 0, 50)
	for i := 0; i < 50; i++ {
		metas = append(metas, mongostore.ParsedDocumentMeta{
			UploadUUID:  "u" + pad2(i),
			Title:       "文档",
			ContentHash: "h",
			SizeChars:   100 + i,
		})
	}
	reader := &fakeKGReader{metas: metas}
	e := newKGEngine("internal-secret", reader)

	// Default page: limit 50, no cursor, full page → next_cursor = last uuid.
	code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", kgHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if reader.gotUID != 7 || reader.gotLimit != 50 || reader.gotCursor != "" {
		t.Fatalf("store args = uid %d limit %d cursor %q", reader.gotUID, reader.gotLimit, reader.gotCursor)
	}
	assertKeys(t, body, "items", "next_cursor")
	items, _ := body["items"].([]any)
	if len(items) != 50 {
		t.Fatalf("items = %d", len(items))
	}
	assertKeys(t, items[0].(map[string]any), "upload_uuid", "title", "content_hash", "size_chars")
	if items[0].(map[string]any)["size_chars"] != float64(100) {
		t.Fatalf("size_chars not forwarded: %v", items[0])
	}
	if body["next_cursor"] != "u49" {
		t.Fatalf("next_cursor = %v, want u49", body["next_cursor"])
	}

	// Cursor is forwarded as the exclusive lower bound.
	reader.metas = metas[:2]
	code, body = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/documents?uid=7&limit=2&cursor=u07", "", kgHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if reader.gotCursor != "u07" || reader.gotLimit != 2 {
		t.Fatalf("store args = cursor %q limit %d", reader.gotCursor, reader.gotLimit)
	}
	if body["next_cursor"] != "u01" {
		t.Fatalf("next_cursor = %v, want u01 (full page)", body["next_cursor"])
	}

	// Short page = last page → null cursor.
	reader.metas = metas[:1]
	_, body = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/documents?uid=7&limit=2&cursor=u07", "", kgHeaders())
	if body["next_cursor"] != nil {
		t.Fatalf("short page must end pagination: %v", body["next_cursor"])
	}

	// limit is clamped into 1..100.
	reader.metas = nil
	_, _ = doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7&limit=1000", "", kgHeaders())
	if reader.gotLimit != 100 {
		t.Fatalf("limit 1000 clamped to %d, want 100", reader.gotLimit)
	}
	_, _ = doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7&limit=0", "", kgHeaders())
	if reader.gotLimit != 1 {
		t.Fatalf("limit 0 clamped to %d, want 1", reader.gotLimit)
	}
}

func TestKGDocumentsListingErrorIs500(t *testing.T) {
	e := newKGEngine("internal-secret", &fakeKGReader{listErr: errors.New("mongo down")})
	if code, body := doJSON(t, e, http.MethodGet, "/internal/cloud/kg/documents?uid=7", "", kgHeaders()); code != http.StatusInternalServerError {
		t.Fatalf("store failure must be 500, got %d %v", code, body)
	}
}

// ── per-document read ──────────────────────────────────────────────

func TestKGDocumentBodyTruncation(t *testing.T) {
	// 200001 CJK characters: one over the budget, each 3 bytes in UTF-8.
	full := strings.Repeat("云", 200001)
	reader := &fakeKGReader{doc: &mongostore.ParsedDocument{
		UploadUUID: "u1", Title: "云文档", ContentHash: "h1", SizeChars: 0, Text: full,
	}}
	e := newKGEngine("internal-secret", reader)

	code, body := doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=u1", "", kgHeaders())
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if reader.gotUID != 7 || reader.gotUUID != "u1" {
		t.Fatalf("store args = uid %d uuid %q", reader.gotUID, reader.gotUUID)
	}
	assertKeys(t, body, "upload_uuid", "title", "content_hash", "size_chars", "text")
	text, _ := body["text"].(string)
	if utf8.RuneCountInString(text) != 200000 {
		t.Fatalf("text runes = %d, want 200000", utf8.RuneCountInString(text))
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, utf8.RuneError) {
		t.Fatalf("truncation split a multi-byte rune")
	}
	if !strings.HasPrefix(text, "云") {
		t.Fatalf("text content changed at the head")
	}
	// size_chars describes the FULL text (0 stored → computed from the body),
	// so callers can detect the truncation.
	if body["size_chars"] != float64(200001) {
		t.Fatalf("size_chars = %v, want full 200001", body["size_chars"])
	}

	// Exactly at the budget: returned verbatim, still 200000.
	reader.doc = &mongostore.ParsedDocument{
		UploadUUID: "u1", ContentHash: "h1", SizeChars: 200000,
		Text: strings.Repeat("云", 200000),
	}
	_, body = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=u1", "", kgHeaders())
	if got := utf8.RuneCountInString(body["text"].(string)); got != 200000 {
		t.Fatalf("exact-budget text runes = %d", got)
	}
	if body["size_chars"] != float64(200000) {
		t.Fatalf("stored size_chars not forwarded: %v", body["size_chars"])
	}

	// Short document: body kept whole, size computed when not persisted.
	reader.doc = &mongostore.ParsedDocument{UploadUUID: "u2", Title: "短", ContentHash: "h2",
		Text: "  中文 body  "}
	_, body = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=u2", "", kgHeaders())
	if body["text"] != "  中文 body  " || body["size_chars"] != float64(utf8.RuneCountInString("  中文 body  ")) {
		t.Fatalf("short document payload = %v", body)
	}
	if body["upload_uuid"] != "u2" || body["title"] != "短" || body["content_hash"] != "h2" {
		t.Fatalf("document identity wrong: %v", body)
	}
}

func TestKGDocumentMissingAndErrors(t *testing.T) {
	// No parsed document for that uid → 404 (absence and empty text are not
	// distinguished by contract).
	e := newKGEngine("internal-secret", &fakeKGReader{})
	code, body := doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=missing", "", kgHeaders())
	if code != http.StatusNotFound || body["detail"] != "Document not found" {
		t.Fatalf("missing document = %d %v", code, body)
	}

	// Store failure → 500, never a misleading 404.
	e = newKGEngine("internal-secret", &fakeKGReader{getErr: errors.New("mongo down")})
	if code, _ := doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=7&upload_uuid=u1", "", kgHeaders()); code != http.StatusInternalServerError {
		t.Fatalf("store failure must be 500, got %d", code)
	}

	// uid comes from the middleware, not from a handler-level query parse.
	reader := &fakeKGReader{doc: &mongostore.ParsedDocument{UploadUUID: "u1", Text: "x"}}
	e = newKGEngine("internal-secret", reader)
	_, _ = doJSON(t, e, http.MethodGet,
		"/internal/cloud/kg/document?uid=42&upload_uuid=u1", "", kgHeaders())
	if reader.gotUID != 42 {
		t.Fatalf("uid from middleware = %d, want 42", reader.gotUID)
	}
}

// pad2 zero-pads a small int for stable uuid ordering.
func pad2(n int) string {
	if n < 10 {
		return "0" + string(rune('0'+n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}
