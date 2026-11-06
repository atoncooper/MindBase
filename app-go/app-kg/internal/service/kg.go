package service

import (
	"context"

	mysqlrepo "app-kg/internal/repo/mysql"
	neo4jrepo "app-kg/internal/repo/neo4j"
)

// KGService — business orchestration of the kg.v1 surface over the shared
// MySQL bookkeeping (video.kg_status/kg_version + scope resolution) and the
// Neo4j graph.
type KGService struct {
	pages *mysqlrepo.PageRepo
	graph *neo4jrepo.GraphRepo
}

// NewKG wires the service onto the repositories.
func NewKG(pages *mysqlrepo.PageRepo, graph *neo4jrepo.GraphRepo) *KGService {
	return &KGService{pages: pages, graph: graph}
}

// Domain read models are aliases of the repo projections: transports import
// the service package only (never repo), while repo stays the single owner of
// the row shape.
type (
	PendingPage      = mysqlrepo.PendingPage
	Neighbor         = neo4jrepo.Neighbor
	Evidence         = neo4jrepo.Evidence
	Relation         = neo4jrepo.Relation
	Entity           = neo4jrepo.Entity
	Exposure         = neo4jrepo.Exposure
	ExposureEvidence = neo4jrepo.ExposureEvidence
	Appearance       = neo4jrepo.Appearance
	TopEntity        = neo4jrepo.TopEntity
	Edge             = neo4jrepo.Edge
	EntityInput      = neo4jrepo.EntityInput
	AppearanceInput  = neo4jrepo.AppearanceInput
	RelationInput    = neo4jrepo.RelationInput
	CloudDocEvidence = neo4jrepo.CloudDocEvidence
)

// BeginResult mirrors the Phase-1 bookkeeping outcome of the historical
// Python process_page: missing row / ASR not done / idempotent skip / marked
// processing.
type BeginResult struct {
	Found          bool
	AsrDone        bool
	Skip           bool
	Reason         string
	ContentVersion int64
	PageTitle      string
	PageIndex      int32
}

// Stats is the composed service counter (graph + pending pages). Evidence is
// the video-only counter; cloud-document knowledge evidence is reported
// separately (CloudDocs/CloudEvidence).
type Stats struct {
	Entities      int64
	Relations     int64
	Evidence      int64
	Videos        int64
	PendingPages  int64
	CloudDocs     int64
	CloudEvidence int64
}

// ResolveScope resolves favorite folders → bvids (dedup, order-stable). Empty
// folderIDs = all of the user's non-deleted folders. Port of
// chat/scope.get_media_ids_for_uid + get_bvids_by_media_ids.
func (s *KGService) ResolveScope(ctx context.Context, uid int64, folderIDs []int64) ([]string, error) {
	if uid <= 0 {
		return nil, invalidf("uid must be positive")
	}
	mediaIDs, err := s.pages.MediaIDs(ctx, uid, folderIDs)
	if err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	uniq := make([]int64, 0, len(mediaIDs))
	for _, mediaID := range mediaIDs {
		if mediaID != 0 && !seen[mediaID] {
			seen[mediaID] = true
			uniq = append(uniq, mediaID)
		}
	}
	if len(uniq) == 0 {
		return nil, nil
	}
	bvids, err := s.pages.BvidsByMediaIDs(ctx, uniq)
	if err != nil {
		return nil, err
	}
	seenBv := map[string]bool{}
	out := make([]string, 0, len(bvids))
	for _, bvid := range bvids {
		if bvid != "" && !seenBv[bvid] {
			seenBv[bvid] = true
			out = append(out, bvid)
		}
	}
	return out, nil
}

// SelectPendingPages picks pages whose ASR is done and whose kg extraction is
// missing / failed / stale.
func (s *KGService) SelectPendingPages(ctx context.Context, bvids []string, limit int32) ([]PendingPage, error) {
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.pages.ListPending(ctx, bvids, limit)
}

// BeginPage performs the idempotency check and marks the page processing
// (Phase 1 of the build flow): missing row / ASR not done → typed result;
// done-and-current (only when expectedVersion is unset) → skip=true;
// otherwise kg_status='processing'.
func (s *KGService) BeginPage(ctx context.Context, bvid string, cid int64, expectedVersion *int64) (BeginResult, error) {
	if bvid == "" {
		return BeginResult{}, invalidf("bvid is required")
	}
	row, err := s.pages.GetPage(ctx, bvid, cid)
	if err != nil {
		return BeginResult{}, err
	}
	if row == nil {
		return BeginResult{Found: false, Reason: "video page not found"}, ErrPageNotFound
	}

	res := BeginResult{
		Found:     true,
		AsrDone:   row.IsProcess,
		PageTitle: row.PageTitle,
		PageIndex: row.PageIndex,
	}
	if !row.IsProcess {
		res.Reason = "ASR not done yet"
		return res, nil
	}
	if expectedVersion != nil {
		res.ContentVersion = *expectedVersion
	} else {
		res.ContentVersion = row.Version
	}
	if row.KgStatus != nil && *row.KgStatus == "done" &&
		row.KgVersion != nil && *row.KgVersion == res.ContentVersion &&
		expectedVersion == nil {
		res.Skip = true
		res.Reason = "up to date"
		return res, nil
	}
	if err := s.pages.SetStatus(ctx, bvid, cid, "processing"); err != nil {
		return res, err
	}
	return res, nil
}

// MarkPageDone sets kg_status='done' + kg_version=content_version (Phase 7).
func (s *KGService) MarkPageDone(ctx context.Context, bvid string, cid, contentVersion int64) error {
	if bvid == "" {
		return invalidf("bvid is required")
	}
	return s.pages.MarkDone(ctx, bvid, cid, contentVersion)
}

// MarkPageFailed marks the page failed (retryable) — failure isolation path.
func (s *KGService) MarkPageFailed(ctx context.Context, bvid string, cid int64) error {
	if bvid == "" {
		return invalidf("bvid is required")
	}
	return s.pages.SetStatus(ctx, bvid, cid, "failed")
}

// CountPendingPages is the scope-free stats counter.
func (s *KGService) CountPendingPages(ctx context.Context) (int64, error) {
	return s.pages.CountPending(ctx)
}
