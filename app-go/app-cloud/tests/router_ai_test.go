package tests

import (
	"errors"
	"net/http"
	"testing"

	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/model"
	"app-cloud/internal/service"
)

func summaryFixture() *service.SummaryService {
	file := &model.CloudFile{
		UploadUUID: "u1", UID: 7, OriginalName: "报告.pdf", Title: strPtr("季度报告"),
		MimeType: "application/pdf", FileSize: 2048, ContentHash: strPtr("hash-1"),
	}
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{"u1": file}}
	store := &fakeSummaryStore{stored: map[string]*mongostore.StoredSummary{
		"u1": {
			Model:       "z-ai/glm-5.3-flash",
			ContentHash: "hash-1",
			Summary: map[string]any{
				"overview":          "报告概览",
				"topics":            []any{"主题"},
				"entities":          []any{"实体"},
				"key_points":        []any{"要点"},
				"todos":             []any{"待办"},
				"answers_questions": []any{"问题"},
				"language":          "zh",
				"size_chars":        512,
			},
		},
	}}
	return service.NewSummaryServiceWithPorts(nil, files, store)
}

// semanticSearchFixture wires a search service over in-memory ports.
func semanticSearchFixture(hits []model.ChunkHit, embedErr, indexErr error) *service.SearchService {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{
		"u1": {UploadUUID: "u1", UID: 7, OriginalName: "报告.pdf", Title: strPtr("季度报告"),
			MimeType: "application/pdf", FileSize: 2048},
	}}
	return service.NewSearchServiceWithPorts(nil, files, &fakeFolderTree{ids: []int64{1}},
		nil, &fakeEmbedder{err: embedErr}, &fakeSemanticIndex{hits: hits, err: indexErr})
}

// ── owner summary endpoint ─────────────────────────────────────────

func TestVideoSummaryReturnsSummaryAndFileIdentity(t *testing.T) {
	e := newAIRouter(t, "", summaryFixture(), nil)
	code, body := doJSON(t, e, http.MethodGet, "/cloud/video/u1/summary", "7", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if body["upload_uuid"] != "u1" || body["original_name"] != "报告.pdf" || body["title"] != "季度报告" {
		t.Fatalf("file identity fields missing: %v", body)
	}
	if body["available"] != true || body["stale"] != false || body["model"] != "z-ai/glm-5.3-flash" {
		t.Fatalf("summary state wrong: %v", body)
	}
	sum, ok := body["summary"].(map[string]any)
	if !ok {
		t.Fatalf("summary payload missing: %v", body["summary"])
	}
	if sum["overview"] != "报告概览" || sum["size_chars"] != float64(512) {
		t.Fatalf("summary content wrong: %v", sum)
	}
	todos, ok := sum["todos"].([]any)
	if !ok || len(todos) != 1 || todos[0] != "待办" {
		t.Fatalf("todos missing: %v", sum["todos"])
	}
}

func TestVideoSummaryWithoutSummaryStillReturnsIdentity(t *testing.T) {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{
		"u2": {UploadUUID: "u2", UID: 7, OriginalName: "无摘要.docx", MimeType: "text/plain"},
	}}
	summary := service.NewSummaryServiceWithPorts(nil, files, &fakeSummaryStore{})
	e := newAIRouter(t, "", summary, nil)
	code, body := doJSON(t, e, http.MethodGet, "/cloud/video/u2/summary", "7", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if body["available"] != false || body["summary"] != nil || body["stale"] != false {
		t.Fatalf("missing summary must report unavailable: %v", body)
	}
	if body["original_name"] != "无摘要.docx" || body["title"] != "" {
		t.Fatalf("identity must be present without a summary: %v", body)
	}
}

func TestVideoSummaryAuthAndNotFound(t *testing.T) {
	e := newAIRouter(t, "", summaryFixture(), nil)
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/video/u1/summary", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing X-Uid must be 401, got %d", code)
	}
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/video/missing/summary", "7", nil); code != http.StatusNotFound {
		t.Fatalf("missing file must be 404, got %d", code)
	}
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/video/u1/summary", "8", nil); code != http.StatusNotFound {
		t.Fatalf("foreign file must be 404, got %d", code)
	}
}

// ── internal summary endpoint ──────────────────────────────────────

func TestInternalSummaryAuth(t *testing.T) {
	summary := summaryFixture()
	// Unconfigured key: fail closed before any credential comparison.
	noKey := newAIRouter(t, "", summary, nil)
	if code, _ := doJSON(t, noKey, http.MethodGet, "/internal/cloud/summary?uid=7&upload_uuid=u1", "", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured internal key must be 503, got %d", code)
	}

	withKey := newAIRouter(t, "internal-secret", summary, nil)
	path := "/internal/cloud/summary?uid=7&upload_uuid=u1"
	if code, _ := doJSON(t, withKey, http.MethodGet, path, "", nil); code != http.StatusUnauthorized {
		t.Fatalf("missing apikey must be 401, got %d", code)
	}
	if code, _ := doJSON(t, withKey, http.MethodGet, path, "", map[string]string{"apikey": "wrong"}); code != http.StatusUnauthorized {
		t.Fatalf("wrong apikey must be 401, got %d", code)
	}
	code, body := doJSON(t, withKey, http.MethodGet, path, "", map[string]string{"apikey": "internal-secret"})
	if code != http.StatusOK {
		t.Fatalf("valid apikey must pass, got %d %v", code, body)
	}
	if body["original_name"] != "报告.pdf" || body["title"] != "季度报告" || body["available"] != true {
		t.Fatalf("M2M summary payload wrong: %v", body)
	}
	// Bearer form is accepted for symmetry with the other internal endpoints.
	bearer := map[string]string{"Authorization": "Bearer internal-secret"}
	if code, _ := doJSON(t, withKey, http.MethodGet, path, "", bearer); code != http.StatusOK {
		t.Fatalf("Bearer apikey must pass, got %d", code)
	}
	if code, _ := doJSON(t, withKey, http.MethodGet,
		"/internal/cloud/summary?upload_uuid=u1", "", map[string]string{"apikey": "internal-secret"}); code != http.StatusUnprocessableEntity {
		t.Fatalf("missing uid must be 422, got %d", code)
	}
}

// ── semantic search endpoint ───────────────────────────────────────

func TestSearchSemanticEndpoint(t *testing.T) {
	hits := []model.ChunkHit{{UploadUUID: "u1", Text: "相关片段", Score: 0.87}}
	e := newAIRouter(t, "", nil, semanticSearchFixture(hits, nil, nil))
	code, body := doJSON(t, e, http.MethodGet, "/cloud/search/semantic?q=报告&limit=5", "7", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if body["mode"] != "semantic" || body["total"] != float64(1) {
		t.Fatalf("envelope wrong: %v", body)
	}
	results, _ := body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results = %v", body["results"])
	}
	hit, _ := results[0].(map[string]any)
	if hit["upload_uuid"] != "u1" || hit["original_name"] != "报告.pdf" || hit["score"] != 0.87 {
		t.Fatalf("result shape wrong: %v", hit)
	}
	if snippets, _ := hit["snippets"].([]any); len(snippets) != 1 {
		t.Fatalf("snippets missing: %v", hit["snippets"])
	}

	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/search/semantic", "7", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("missing q must be 422, got %d", code)
	}
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/search/semantic?q=x&folderId=abc", "7", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("bad folderId must be 422, got %d", code)
	}
}

func TestSearchSemanticUnavailableIs503(t *testing.T) {
	e := newAIRouter(t, "", nil, semanticSearchFixture(nil, nil, errors.New("milvus down")))
	if code, body := doJSON(t, e, http.MethodGet, "/cloud/search/semantic?q=x", "7", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("index failure must be 503, got %d %v", code, body)
	}
	// No search service wired at all (pipeline/Milvus disabled).
	e = newAIRouter(t, "", nil, nil)
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/search/semantic?q=x", "7", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("disabled semantic search must be 503, got %d", code)
	}
}

// ── similar endpoint ───────────────────────────────────────────────

func TestSimilarEndpoint(t *testing.T) {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{
		"u1": {UploadUUID: "u1", UID: 7, OriginalName: "报告.pdf", MimeType: "application/pdf"},
	}}
	search := service.NewSearchServiceWithPorts(nil, files, &fakeFolderTree{}, nil,
		&fakeEmbedder{}, &fakeSemanticIndex{hits: []model.ChunkHit{{UploadUUID: "u1", Text: "t", Score: 0.5}}})
	e := newAIRouter(t, "", nil, search)
	code, body := doJSON(t, e, http.MethodGet, "/cloud/video/u1/similar?limit=5", "7", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, body)
	}
	if items, ok := body["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("self must be excluded and items must be an array: %v", body["items"])
	}
	if code, _ := doJSON(t, e, http.MethodGet, "/cloud/video/missing/similar", "7", nil); code != http.StatusNotFound {
		t.Fatalf("missing file must be 404, got %d", code)
	}
}

func TestInternalSimilarAuth(t *testing.T) {
	files := &fakeFileCatalog{files: map[string]*model.CloudFile{
		"u1": {UploadUUID: "u1", UID: 7, OriginalName: "报告.pdf", MimeType: "application/pdf"},
	}}
	search := service.NewSearchServiceWithPorts(nil, files, &fakeFolderTree{}, nil,
		&fakeEmbedder{}, &fakeSemanticIndex{})
	path := "/internal/cloud/similar?uid=7&upload_uuid=u1"
	if code, _ := doJSON(t, newAIRouter(t, "", nil, search), http.MethodGet, path, "", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured key must be 503, got %d", code)
	}
	withKey := newAIRouter(t, "internal-secret", nil, search)
	if code, _ := doJSON(t, withKey, http.MethodGet, path, "", map[string]string{"apikey": "wrong"}); code != http.StatusUnauthorized {
		t.Fatalf("wrong apikey must be 401, got %d", code)
	}
	if code, body := doJSON(t, withKey, http.MethodGet, path, "", map[string]string{"apikey": "internal-secret"}); code != http.StatusOK {
		t.Fatalf("valid apikey must pass, got %d %v", code, body)
	}
}
