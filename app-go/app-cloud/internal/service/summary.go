package service

// Summary read model: the owner endpoint and the machine-to-machine endpoint
// both serve the summary the vectorize run persisted in MongoDB, plus the
// freshness verdict (did the document content change since the summary was
// generated?).

import (
	"context"
	"encoding/json"
	"log/slog"

	"app-cloud/internal/infra/mongostore"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// SummaryView — one file's summary state as served over HTTP. OriginalName
// and Title identify the file even when no summary exists yet (M2M callers
// render them as the source label).
type SummaryView struct {
	UploadUUID   string
	OriginalName string
	Title        string
	Available    bool
	Stale        bool
	Model        string
	Summary      *Summary // nil when not generated yet
}

// SummaryStore is the read port for stored summaries (implemented by
// mongostore.MongoStore; nil-safe).
type SummaryStore interface {
	GetSummaryByUUID(ctx context.Context, uid int64, uploadUUID string) (*mongostore.StoredSummary, error)
}

// FileLookup is the owner-scoped file lookup needed to validate a summary
// request (implemented by repo.FileRepo).
type FileLookup interface {
	GetByUUID(db *gorm.DB, uploadUUID string, uid int64) (*model.CloudFile, error)
}

// SummaryService resolves a file's summary for one owner.
type SummaryService struct {
	db    *gorm.DB
	files FileLookup
	store SummaryStore
}

// NewSummaryService wires the production ports (file repo + Mongo store).
func NewSummaryService(db *gorm.DB, store SummaryStore) *SummaryService {
	return NewSummaryServiceWithPorts(db, repo.NewFileRepo(), store)
}

// NewSummaryServiceWithPorts builds the service over explicit ports. Besides
// wiring decisions, it lets tests substitute the file lookup and summary store
// without a live MySQL/Mongo.
func NewSummaryServiceWithPorts(db *gorm.DB, files FileLookup, store SummaryStore) *SummaryService {
	return &SummaryService{db: db, files: files, store: store}
}

// Get returns the summary view for one owner-scoped file. ErrNotFound means
// the file does not exist (or is trashed) for this owner; a file without a
// summary is not an error — the view simply reports available=false.
func (s *SummaryService) Get(ctx context.Context, uid int64, uploadUUID string) (*SummaryView, error) {
	f, err := s.files.GetByUUID(s.db, uploadUUID, uid)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrNotFound
	}
	view := &SummaryView{UploadUUID: uploadUUID, OriginalName: f.OriginalName}
	if f.Title != nil {
		view.Title = *f.Title
	}
	if s.store == nil {
		return view, nil
	}
	stored, err := s.store.GetSummaryByUUID(ctx, uid, uploadUUID)
	if err != nil {
		return nil, err
	}
	if stored == nil {
		return view, nil
	}
	sum, derr := decodeStoredSummary(stored.Summary)
	if derr != nil {
		// A malformed stored summary must not fail the read: report it as
		// unavailable so the UI offers a re-process instead of a 500.
		slog.Warn("[CLOUD_SUMMARY] stored summary could not be decoded",
			"upload_uuid", uploadUUID, "err", derr)
		return view, nil
	}
	fileHash := ""
	if f.ContentHash != nil {
		fileHash = *f.ContentHash
	}
	view.Available = true
	view.Model = stored.Model
	view.Summary = sum
	// Stale = the summary was generated from different content than the file
	// currently has (re-uploaded/reprocessed without a fresh summary).
	view.Stale = stored.ContentHash != fileHash
	return view, nil
}

// decodeStoredSummary maps the raw BSON summary document onto the typed
// summary. Documents written before a field existed decode with empty lists.
func decodeStoredSummary(raw map[string]any) (*Summary, error) {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var sum Summary
	if err := json.Unmarshal(encoded, &sum); err != nil {
		return nil, err
	}
	if sum.Topics == nil {
		sum.Topics = []string{}
	}
	if sum.Entities == nil {
		sum.Entities = []string{}
	}
	if sum.KeyPoints == nil {
		sum.KeyPoints = []string{}
	}
	if sum.Todos == nil {
		sum.Todos = []string{}
	}
	if sum.AnswersQuestions == nil {
		sum.AnswersQuestions = []string{}
	}
	return &sum, nil
}
