package service

// Semantic read path over the drive's chunk vectors: folder-scoped semantic
// search and "similar files". Querying is read-only — embeddings come from the
// same gateway/model the vectorize pipeline wrote with, and the Milvus filter
// is assembled here from the authenticated uid only (never from client input).
//
// Availability is honest: when the embedding gateway or the vector index is
// not wired the call reports ErrSemanticUnavailable, which the router maps to
// 503 — file-name search keeps working independently.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"app-cloud/internal/model"
	"app-cloud/internal/repo"
	"app-cloud/internal/utils"

	"gorm.io/gorm"
)

// ErrSemanticUnavailable — embedding gateway or vector index unavailable.
var ErrSemanticUnavailable = errors.New("语义检索暂不可用")

const (
	semanticMaxSnippets     = 3
	semanticSnippetRunes    = 200
	semanticOverfetchFactor = 4
	semanticMinFetch        = 20
	semanticMaxFetch        = 100
	semanticQueryMaxRunes   = 2000
	// semanticFilterInListMax caps how many upload_uuids are pushed into the
	// Milvus expression; beyond it the allowed set is applied after the
	// search with a wider over-fetch.
	semanticFilterInListMax     = 200
	semanticWideOverfetchFactor = 10
	semanticWideMaxFetch        = 400
)

// SemanticResult — one ranked drive file. Chunk hits are aggregated per
// upload_uuid: best score wins, snippets keep the strongest distinct chunks.
type SemanticResult struct {
	UploadUUID   string
	OriginalName string
	Title        string
	MimeType     string
	FileSize     int64
	Score        float64
	Snippets     []string
}

// SemanticIndex is the vector-read port (implemented by
// milvusstore.MilvusStore). filter is always built by this package.
type SemanticIndex interface {
	SearchChunks(ctx context.Context, vector []float32, filter string, limit int) ([]model.ChunkHit, error)
}

// EmbeddingClient is the embedding port (implemented by pipeline.Embedder;
// the same model that produced the stored vectors).
type EmbeddingClient interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

// SemanticFileReader — owner-scoped file reads used to scope and hydrate hits.
type SemanticFileReader interface {
	GetByUUID(db *gorm.DB, uploadUUID string, uid int64) (*model.CloudFile, error)
	ListByUUIDs(db *gorm.DB, uid int64, uploadUUIDs []string) ([]model.CloudFile, error)
	ListActiveByFolderIDs(db *gorm.DB, uid int64, folderIDs []int64) ([]model.CloudFile, error)
}

// FolderTreeReader — recursive folder subtree ids (repo.FolderRepo).
type FolderTreeReader interface {
	SubtreeIDs(db *gorm.DB, id int64, uid int64, includeChildren bool) ([]int64, error)
}

// SearchService answers semantic search and similar-file queries for one uid.
type SearchService struct {
	db        *gorm.DB
	files     SemanticFileReader
	folders   FolderTreeReader
	summaries *SummaryService
	embedder  EmbeddingClient
	index     SemanticIndex
}

// NewSearchService wires the production ports. A nil embedder/index disables
// the service (calls answer ErrSemanticUnavailable).
func NewSearchService(db *gorm.DB, embedder EmbeddingClient, index SemanticIndex,
	summaries *SummaryService) *SearchService {
	return NewSearchServiceWithPorts(db, repo.NewFileRepo(), repo.NewFolderRepo(),
		summaries, embedder, index)
}

// NewSearchServiceWithPorts builds the service over explicit ports; tests use
// it to substitute the vector index, embedder and file/folder readers.
func NewSearchServiceWithPorts(db *gorm.DB, files SemanticFileReader, folders FolderTreeReader,
	summaries *SummaryService, embedder EmbeddingClient, index SemanticIndex) *SearchService {
	return &SearchService{db: db, files: files, folders: folders,
		summaries: summaries, embedder: embedder, index: index}
}

// available reports whether the semantic path can run at all.
func (s *SearchService) available() bool {
	return s != nil && s.embedder != nil && s.index != nil
}

// SearchSemantic ranks the user's files for a free-text query, optionally
// restricted to a folder subtree.
func (s *SearchService) SearchSemantic(ctx context.Context, uid int64, q string,
	folderID *int64, limit int) ([]SemanticResult, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, nil
	}
	if !s.available() {
		return nil, ErrSemanticUnavailable
	}
	if limit <= 0 {
		limit = 10
	}
	allowed, err := s.allowedSet(uid, folderID)
	if err != nil {
		return nil, err
	}
	if folderID != nil && allowed != nil && len(allowed) == 0 {
		// The folder (or its subtree) holds no active files — nothing to
		// search, and running a widened query would surface unrelated files.
		return nil, nil
	}
	vectors, err := s.embedder.Embed(ctx, []string{utils.TruncateRunes(q, semanticQueryMaxRunes)})
	if err != nil || len(vectors) == 0 {
		return nil, fmt.Errorf("%w: embedding: %v", ErrSemanticUnavailable, err)
	}
	fetch := s.fetchLimit(limit)
	filter := uidFilter(uid)
	if allowed != nil {
		if len(allowed) <= semanticFilterInListMax {
			// Small folder scope: push the allowed files into the Milvus
			// expression so folder-outside chunks cannot occupy the top-N.
			filter = uploadUUIDInFilter(uid, allowed)
		} else {
			// Huge folder scope: an expression listing thousands of uuids is
			// worse than filtering after the fact, so over-fetch instead.
			fetch = s.wideFetchLimit(limit)
		}
	}
	hits, err := s.index.SearchChunks(ctx, vectors[0], filter, fetch)
	if err != nil {
		return nil, fmt.Errorf("%w: index: %v", ErrSemanticUnavailable, err)
	}
	return s.collect(uid, hits, limit, nil, allowed)
}

// Similar returns the user's files whose content is closest to one file,
// excluding the file itself. The query vector uses the file's summary
// overview plus its display title, falling back to the file name when no
// summary exists.
func (s *SearchService) Similar(ctx context.Context, uid int64, uploadUUID string,
	limit int) ([]SemanticResult, error) {
	if !s.available() {
		return nil, ErrSemanticUnavailable
	}
	if limit <= 0 {
		limit = 5
	}
	f, err := s.files.GetByUUID(s.db, uploadUUID, uid)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrNotFound
	}
	query := s.similarQueryText(ctx, uid, f)
	vectors, err := s.embedder.Embed(ctx, []string{utils.TruncateRunes(query, semanticQueryMaxRunes)})
	if err != nil || len(vectors) == 0 {
		return nil, fmt.Errorf("%w: embedding: %v", ErrSemanticUnavailable, err)
	}
	hits, err := s.index.SearchChunks(ctx, vectors[0], uidFilter(uid), s.fetchLimit(limit))
	if err != nil {
		return nil, fmt.Errorf("%w: index: %v", ErrSemanticUnavailable, err)
	}
	return s.collect(uid, hits, limit, map[string]bool{uploadUUID: true}, nil)
}

// similarQueryText builds the probe text: title (+ summary overview when the
// file has one). Summary reads are best-effort — a missing Mongo store simply
// degrades to the title.
func (s *SearchService) similarQueryText(ctx context.Context, uid int64, f *model.CloudFile) string {
	title := strings.TrimSpace(f.OriginalName)
	if f.Title != nil && strings.TrimSpace(*f.Title) != "" {
		title = strings.TrimSpace(*f.Title)
	}
	if s.summaries != nil {
		if view, err := s.summaries.Get(ctx, uid, f.UploadUUID); err == nil &&
			view.Available && view.Summary != nil {
			if overview := strings.TrimSpace(view.Summary.Overview); overview != "" {
				return title + "\n" + overview
			}
		}
	}
	return title
}

// allowedSet returns the set of upload_uuids inside a folder subtree, or nil
// when no folder scope is requested.
func (s *SearchService) allowedSet(uid int64, folderID *int64) (map[string]bool, error) {
	if folderID == nil {
		return nil, nil
	}
	ids, err := s.folders.SubtreeIDs(s.db, *folderID, uid, true)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return map[string]bool{}, nil
	}
	rows, err := s.files.ListActiveByFolderIDs(s.db, uid, ids)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(rows))
	for i := range rows {
		allowed[rows[i].UploadUUID] = true
	}
	return allowed, nil
}

// fetchLimit over-fetches chunks so per-file aggregation and folder filtering
// still yield the requested number of distinct files.
func (s *SearchService) fetchLimit(limit int) int {
	n := limit * semanticOverfetchFactor
	if n < semanticMinFetch {
		n = semanticMinFetch
	}
	if n > semanticMaxFetch {
		n = semanticMaxFetch
	}
	return n
}

// wideFetchLimit over-fetches harder when a large folder scope can only be
// applied after the vector search (folder-outside chunks are discarded by
// collect, so the raw hit budget must cover them).
func (s *SearchService) wideFetchLimit(limit int) int {
	n := limit * semanticWideOverfetchFactor
	if n < semanticMinFetch {
		n = semanticMinFetch
	}
	if n > semanticWideMaxFetch {
		n = semanticWideMaxFetch
	}
	return n
}

// uploadUUIDInFilter builds the folder-scope expression: the uid predicate
// plus an upload_uuid in-list. Every value is a server-side uuid and is
// escaped, so no caller-controlled text reaches the expression.
func uploadUUIDInFilter(uid int64, allowed map[string]bool) string {
	uuids := make([]string, 0, len(allowed))
	for uuid := range allowed {
		uuids = append(uuids, uuid)
	}
	sort.Strings(uuids)
	quoted := make([]string, len(uuids))
	for i, uuid := range uuids {
		quoted[i] = quoteMilvusString(uuid)
	}
	return uidFilter(uid) + " && upload_uuid in [" + strings.Join(quoted, ", ") + "]"
}

// quoteMilvusString renders s as a double-quoted Milvus string literal.
func quoteMilvusString(s string) string {
	escaped := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(s)
	return "\"" + escaped + "\""
}

// collect aggregates chunk hits into per-file results, hydrates cloud_files
// metadata for the owner and keeps only files that still exist.
func (s *SearchService) collect(uid int64, hits []model.ChunkHit, limit int,
	exclude map[string]bool, allowed map[string]bool) ([]SemanticResult, error) {
	type aggregate struct {
		score    float64
		snippets []string
	}
	aggregated := make(map[string]*aggregate)
	order := make([]string, 0, len(hits))
	for _, hit := range hits {
		uuid := strings.TrimSpace(hit.UploadUUID)
		if uuid == "" || exclude[uuid] {
			continue
		}
		if allowed != nil && !allowed[uuid] {
			continue
		}
		agg := aggregated[uuid]
		if agg == nil {
			agg = &aggregate{score: hit.Score}
			aggregated[uuid] = agg
			order = append(order, uuid)
		} else if hit.Score > agg.score {
			agg.score = hit.Score
		}
		if len(agg.snippets) >= semanticMaxSnippets {
			continue
		}
		snippet := utils.TruncateRunes(strings.TrimSpace(hit.Text), semanticSnippetRunes)
		if snippet == "" || containsString(agg.snippets, snippet) {
			continue
		}
		agg.snippets = append(agg.snippets, snippet)
	}
	if len(order) == 0 {
		return []SemanticResult{}, nil
	}
	rows, err := s.files.ListByUUIDs(s.db, uid, order)
	if err != nil {
		return nil, err
	}
	meta := make(map[string]*model.CloudFile, len(rows))
	for i := range rows {
		meta[rows[i].UploadUUID] = &rows[i]
	}
	results := make([]SemanticResult, 0, len(order))
	for _, uuid := range order {
		f := meta[uuid]
		agg := aggregated[uuid]
		if f == nil || agg == nil {
			continue // deleted / not owned — never surface it
		}
		title := ""
		if f.Title != nil {
			title = strings.TrimSpace(*f.Title)
		}
		snippets := agg.snippets
		if snippets == nil {
			snippets = []string{}
		}
		results = append(results, SemanticResult{
			UploadUUID:   f.UploadUUID,
			OriginalName: f.OriginalName,
			Title:        title,
			MimeType:     f.MimeType,
			FileSize:     f.FileSize,
			Score:        agg.score,
			Snippets:     snippets,
		})
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].Score > results[j].Score })
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// uidFilter is the only identity filter the semantic path ever sends to the
// vector store.
func uidFilter(uid int64) string { return fmt.Sprintf("uid == %d", uid) }

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
