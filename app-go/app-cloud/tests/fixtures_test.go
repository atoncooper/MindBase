// Package tests holds the black-box suite for the cloud document
// intelligence features: OCR, per-file summary, semantic search/similar files
// and the internal machine-to-machine endpoints. Everything here goes through
// the exported API only, so internal layout stays free to change.
package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/model"
	"app-cloud/internal/pipeline"
	"app-cloud/internal/router"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── OCR test helpers ────────────────────────────────────────────────

// testOCRClient points an OCR client at a test gateway.
func testOCRClient(t *testing.T, baseURL string) *pipeline.OCRClient {
	t.Helper()
	cfg := config.OCRConfig{
		Enabled: true, Model: "z-ai/glm-test",
		MaxImageBytes: 1 << 20, MaxPDFPages: 5, MaxImages: 3, TimeoutSecs: 5,
	}
	// OCR has no provider connection of its own: it always uses the shared
	// Higress gateway connection held by the embedding config.
	return pipeline.NewOCRClient(cfg, config.EmbeddingConfig{BaseURL: baseURL, APIKey: "test-key"})
}

// disabledOCRClient is a client whose stage is switched off.
func disabledOCRClient() *pipeline.OCRClient {
	return pipeline.NewOCRClient(config.OCRConfig{}, config.EmbeddingConfig{})
}

// ocrGateway answers OCR calls with the given texts in call order.
func ocrGateway(t *testing.T, texts []string) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		text := texts[(int(n)-1)%len(texts)]
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": text}}},
		})
	}))
	return srv, &calls
}

// ── fake file catalog (owner-scoped reads) ──────────────────────────

type fakeFileCatalog struct {
	files       map[string]*model.CloudFile
	folderFiles []model.CloudFile
	err         error
}

func (f *fakeFileCatalog) GetByUUID(_ *gorm.DB, uploadUUID string, uid int64) (*model.CloudFile, error) {
	if f.err != nil {
		return nil, f.err
	}
	file := f.files[uploadUUID]
	if file == nil || file.UID != uid {
		return nil, nil
	}
	return file, nil
}

func (f *fakeFileCatalog) ListByUUIDs(_ *gorm.DB, uid int64, uploadUUIDs []string) ([]model.CloudFile, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]model.CloudFile, 0, len(uploadUUIDs))
	for _, uuid := range uploadUUIDs {
		if file := f.files[uuid]; file != nil && file.UID == uid {
			out = append(out, *file)
		}
	}
	return out, nil
}

func (f *fakeFileCatalog) ListActiveByFolderIDs(_ *gorm.DB, uid int64, folderIDs []int64) ([]model.CloudFile, error) {
	if f.err != nil {
		return nil, f.err
	}
	allowed := make(map[int64]bool, len(folderIDs))
	for _, id := range folderIDs {
		allowed[id] = true
	}
	out := make([]model.CloudFile, 0)
	for i := range f.folderFiles {
		row := f.folderFiles[i]
		if row.UID == uid && row.FolderID != nil && allowed[*row.FolderID] {
			out = append(out, row)
		}
	}
	return out, nil
}

// ── fake summary store ──────────────────────────────────────────────

type fakeSummaryStore struct {
	stored map[string]*mongostore.StoredSummary
	err    error
}

func (s *fakeSummaryStore) GetSummaryByUUID(_ context.Context, uid int64, uploadUUID string) (*mongostore.StoredSummary, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.stored[uploadUUID], nil
}

// ── fake vector ports ───────────────────────────────────────────────

type fakeEmbedder struct {
	vectors  [][]float32
	err      error
	gotTexts []string
}

func (e *fakeEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	e.gotTexts = append(e.gotTexts, texts...)
	if e.err != nil {
		return nil, e.err
	}
	if e.vectors != nil {
		return e.vectors, nil
	}
	return [][]float32{{0.1, 0.2}}, nil
}

type fakeSemanticIndex struct {
	hits      []model.ChunkHit
	err       error
	gotFilter string
	gotLimit  int
	calls     int
}

func (i *fakeSemanticIndex) SearchChunks(_ context.Context, vector []float32, filter string, limit int) ([]model.ChunkHit, error) {
	i.calls++
	i.gotFilter, i.gotLimit = filter, limit
	if i.err != nil {
		return nil, i.err
	}
	return i.hits, nil
}

type fakeFolderTree struct {
	ids   []int64
	err   error
	calls int
}

func (f *fakeFolderTree) SubtreeIDs(_ *gorm.DB, id int64, uid int64, includeChildren bool) ([]int64, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.ids, nil
}

// ── small value helpers ─────────────────────────────────────────────

func strPtr(s string) *string { return &s }

func int64Ptr(v int64) *int64 { return &v }

func cloudFile(uuid string, uid int64) *model.CloudFile {
	return &model.CloudFile{
		UploadUUID: uuid, UID: uid, OriginalName: uuid + ".pdf",
		MimeType: "application/pdf", FileSize: 100,
	}
}

// ── router helpers ──────────────────────────────────────────────────

// newAIRouter builds the real HTTP engine with the document-intelligence
// services backed by in-memory fixtures.
func newAIRouter(t *testing.T, internalKey string,
	summary *service.SummaryService, search *service.SearchService) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	cfg.Internal.APIKey = internalKey
	return router.New(router.Deps{Cfg: cfg, Summary: summary, Search: search})
}

// doJSON issues a request and decodes the JSON response body.
func doJSON(t *testing.T, e *gin.Engine, method, path, uid string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if uid != "" {
		req.Header.Set("X-Uid", uid)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	body := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
	}
	return rec.Code, body
}
