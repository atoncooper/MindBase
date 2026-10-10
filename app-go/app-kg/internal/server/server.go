// Package server implements the kg.v1.KgGraph gRPC service: proto ↔ graph/db
// mapping, standard health, reflection, and a logging/recovery interceptor.
// The service is a pure data face — no LLM, no embedding, no business logic.
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-kg/internal/db"
	"app-kg/internal/graph"
	"app-kg/internal/kgpb"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Deps wires the storage faces into the gRPC service. MySQL access goes
// through the db package functions (global connection initialized by db.Init
// at boot — the established pattern across the app-go services).
type Deps struct {
	Graph *graph.Store
}

// Server implements kgpb.KgGraphServer. MySQL access goes through the db
// package functions (global connection initialized by db.Init at boot — the
// established pattern across the app-go services).
type Server struct {
	kgpb.UnimplementedKgGraphServer
	g *graph.Store
}

// New builds the server.
func New(d Deps) *Server { return &Server{g: d.Graph} }

func invalid(format string, args ...any) error {
	return status.Errorf(codes.InvalidArgument, format, args...)
}

func internal(op string, err error) error {
	return status.Errorf(codes.Internal, "%s: %v", op, err)
}

// ── 记账（MySQL）──────────────────────────────────────────────────────

func (s *Server) ResolveScope(ctx context.Context, req *kgpb.ResolveScopeRequest) (*kgpb.ResolveScopeResponse, error) {
	if req.Uid <= 0 {
		return nil, invalid("uid must be positive")
	}
	bvids, err := db.ResolveScope(ctx, req.Uid, req.FolderIds)
	if err != nil {
		return nil, internal("resolve scope", err)
	}
	if bvids == nil {
		bvids = []string{}
	}
	return &kgpb.ResolveScopeResponse{Bvids: bvids}, nil
}

func (s *Server) SelectPendingPages(ctx context.Context, req *kgpb.SelectPendingPagesRequest) (*kgpb.SelectPendingPagesResponse, error) {
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	pages, err := db.SelectPendingPages(ctx, req.Bvids, req.Limit)
	if err != nil {
		return nil, internal("select pending pages", err)
	}
	out := make([]*kgpb.PendingPage, 0, len(pages))
	for _, p := range pages {
		out = append(out, &kgpb.PendingPage{
			Bvid:      p.Bvid,
			Cid:       p.Cid,
			PageIndex: p.PageIndex,
			PageTitle: p.PageTitle,
			Version:   p.Version,
		})
	}
	return &kgpb.SelectPendingPagesResponse{Pages: out}, nil
}

func (s *Server) BeginPage(ctx context.Context, req *kgpb.BeginPageRequest) (*kgpb.BeginPageResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	var expected *int64
	if req.ExpectedVersion >= 0 {
		v := req.ExpectedVersion
		expected = &v
	}
	res, err := db.BeginPage(ctx, req.Bvid, req.Cid, expected)
	if err != nil {
		if errors.Is(err, db.ErrPageNotFound) {
			return &kgpb.BeginPageResponse{Found: false, Reason: res.Reason}, nil
		}
		return nil, internal("begin page", err)
	}
	return &kgpb.BeginPageResponse{
		Found:          res.Found,
		AsrDone:        res.AsrDone,
		Skip:           res.Skip,
		Reason:         res.Reason,
		ContentVersion: res.ContentVersion,
		PageTitle:      res.PageTitle,
		PageIndex:      res.PageIndex,
	}, nil
}

func (s *Server) MarkPageDone(ctx context.Context, req *kgpb.MarkPageDoneRequest) (*kgpb.MarkPageDoneResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	if err := db.MarkPageDone(ctx, req.Bvid, req.Cid, req.ContentVersion); err != nil {
		return nil, internal("mark page done", err)
	}
	return &kgpb.MarkPageDoneResponse{}, nil
}

func (s *Server) MarkPageFailed(ctx context.Context, req *kgpb.MarkPageFailedRequest) (*kgpb.MarkPageFailedResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	if err := db.MarkPageFailed(ctx, req.Bvid, req.Cid); err != nil {
		return nil, internal("mark page failed", err)
	}
	return &kgpb.MarkPageFailedResponse{}, nil
}

func (s *Server) CountPendingPages(ctx context.Context, req *kgpb.CountPendingPagesRequest) (*kgpb.CountPendingPagesResponse, error) {
	n, err := db.CountPendingPages(ctx)
	if err != nil {
		return nil, internal("count pending pages", err)
	}
	return &kgpb.CountPendingPagesResponse{Count: n}, nil
}

// ── 图写（Neo4j）──────────────────────────────────────────────────────

func (s *Server) UpsertEntities(ctx context.Context, req *kgpb.UpsertEntitiesRequest) (*kgpb.UpsertEntitiesResponse, error) {
	rows := make([]map[string]any, 0, len(req.Entities))
	for _, e := range req.Entities {
		if e.Name == "" || e.NameLower == "" || e.Eid == "" {
			return nil, invalid("entity requires eid/name/name_lower (caller computes normalization)")
		}
		rows = append(rows, map[string]any{
			"eid": e.Eid, "name": e.Name, "name_lower": e.NameLower,
			"type": e.Type, "description": e.Description, "alias": e.Alias,
		})
	}
	eids, err := s.g.UpsertEntities(ctx, rows)
	if err != nil {
		return nil, internal("upsert entities", err)
	}
	if eids == nil {
		eids = []string{}
	}
	return &kgpb.UpsertEntitiesResponse{Eids: eids}, nil
}

func (s *Server) LinkAppearances(ctx context.Context, req *kgpb.LinkAppearancesRequest) (*kgpb.LinkAppearancesResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	appearances := make([]map[string]any, 0, len(req.Appearances))
	for _, a := range req.Appearances {
		appearances = append(appearances, map[string]any{"eid": a.Eid, "quote": a.Quote})
	}
	linked, err := s.g.LinkAppearances(ctx, req.Bvid, req.PageIndex, appearances)
	if err != nil {
		return nil, internal("link appearances", err)
	}
	return &kgpb.LinkAppearancesResponse{Linked: linked}, nil
}

func (s *Server) UpsertRelations(ctx context.Context, req *kgpb.UpsertRelationsRequest) (*kgpb.UpsertRelationsResponse, error) {
	rows := make([]map[string]any, 0, len(req.Relations))
	for _, r := range req.Relations {
		rows = append(rows, map[string]any{
			"src_eid": r.SrcEid, "dst_eid": r.DstEid,
			"rel_type": r.RelType, "quote": r.Quote,
		})
	}
	if err := s.g.UpsertRelations(ctx, rows); err != nil {
		return nil, internal("upsert relations", err)
	}
	return &kgpb.UpsertRelationsResponse{}, nil
}

func (s *Server) DeletePageEvidence(ctx context.Context, req *kgpb.DeletePageEvidenceRequest) (*kgpb.DeletePageEvidenceResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	deleted, err := s.g.DeletePageEvidence(ctx, req.Bvid, req.PageIndex)
	if err != nil {
		return nil, internal("delete page evidence", err)
	}
	return &kgpb.DeletePageEvidenceResponse{Deleted: deleted}, nil
}

func (s *Server) DeleteVideo(ctx context.Context, req *kgpb.DeleteVideoRequest) (*kgpb.DeleteVideoResponse, error) {
	if req.Bvid == "" {
		return nil, invalid("bvid is required")
	}
	entitiesRemoved, videosRemoved, err := s.g.DeleteVideo(ctx, req.Bvid)
	if err != nil {
		return nil, internal("delete video", err)
	}
	return &kgpb.DeleteVideoResponse{EntitiesRemoved: entitiesRemoved, VideosRemoved: videosRemoved}, nil
}

func (s *Server) ClearAll(ctx context.Context, req *kgpb.ClearAllRequest) (*kgpb.ClearAllResponse, error) {
	if err := s.g.ClearAll(ctx); err != nil {
		return nil, internal("clear all", err)
	}
	return &kgpb.ClearAllResponse{}, nil
}

// ── 图读（Neo4j + video 标题 join）───────────────────────────────────

func (s *Server) Neighbors(ctx context.Context, req *kgpb.NeighborsRequest) (*kgpb.NeighborsResponse, error) {
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	rows, err := s.g.Neighbors(ctx, req.Eids, req.ExcludeEids, req.Limit)
	if err != nil {
		return nil, internal("neighbors", err)
	}
	out := make([]*kgpb.NeighborRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.NeighborRow{
			Eid:         str(r["eid"]),
			Name:        str(r["name"]),
			Type:        str(r["type"]),
			Description: str(r["description"]),
			RelType:     str(r["rel_type"]),
			FromEid:     str(r["from_eid"]),
		})
	}
	return &kgpb.NeighborsResponse{Rows: out}, nil
}

func (s *Server) FetchEvidence(ctx context.Context, req *kgpb.FetchEvidenceRequest) (*kgpb.FetchEvidenceResponse, error) {
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	rows, err := s.g.FetchEvidence(ctx, req.Eids, req.Bvids, req.Limit)
	if err != nil {
		return nil, internal("fetch evidence", err)
	}
	// Title join: (bvid, page_index) → page_title from the video table
	// (retriever._page_titles semantics; missing → "P{n+1}").
	bvSet := map[string]bool{}
	for _, r := range rows {
		if bv := str(r["bvid"]); bv != "" {
			bvSet[bv] = true
		}
	}
	bvids := make([]string, 0, len(bvSet))
	for bv := range bvSet {
		bvids = append(bvids, bv)
	}
	titles, err := db.PageTitles(ctx, bvids)
	if err != nil {
		slog.Warn("[KG_GRPC] page title lookup failed", "err", err)
		titles = map[db.PageKey]string{}
	}
	out := make([]*kgpb.EvidenceRow, 0, len(rows))
	for _, r := range rows {
		bvid := str(r["bvid"])
		pageIndex := int32(i64(r["page_index"]))
		title := titles[db.PageKey{Bvid: bvid, PageIndex: pageIndex}]
		if title == "" {
			title = fmt.Sprintf("P%d", pageIndex+1)
		}
		out = append(out, &kgpb.EvidenceRow{
			Eid:       str(r["eid"]),
			Name:      str(r["name"]),
			Type:      str(r["type"]),
			Bvid:      bvid,
			PageIndex: pageIndex,
			Quote:     str(r["quote"]),
			PageTitle: title,
		})
	}
	return &kgpb.FetchEvidenceResponse{Rows: out}, nil
}

func (s *Server) RelationsAmong(ctx context.Context, req *kgpb.RelationsAmongRequest) (*kgpb.RelationsAmongResponse, error) {
	rows, err := s.g.RelationsAmong(ctx, req.Eids)
	if err != nil {
		return nil, internal("relations among", err)
	}
	out := make([]*kgpb.RelationRow, 0, len(rows))
	for _, r := range rows {
		quotes := strList(r["quotes"])
		out = append(out, &kgpb.RelationRow{
			SrcEid:  str(r["src_eid"]),
			SrcName: str(r["src_name"]),
			RelType: str(r["rel_type"]),
			DstEid:  str(r["dst_eid"]),
			DstName: str(r["dst_name"]),
			Weight:  i64(r["weight"]),
			Quotes:  quotes,
		})
	}
	return &kgpb.RelationsAmongResponse{Rows: out}, nil
}

func (s *Server) EntitiesByEids(ctx context.Context, req *kgpb.EntitiesByEidsRequest) (*kgpb.EntitiesByEidsResponse, error) {
	rows, err := s.g.EntitiesByEids(ctx, req.Eids)
	if err != nil {
		return nil, internal("entities by eids", err)
	}
	out := make([]*kgpb.EntityDetail, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.EntityDetail{
			Eid:         str(r["eid"]),
			Name:        str(r["name"]),
			Type:        str(r["type"]),
			Description: str(r["description"]),
			Aliases:     strList(r["aliases"]),
		})
	}
	return &kgpb.EntitiesByEidsResponse{Rows: out}, nil
}

func (s *Server) EntityExposure(ctx context.Context, req *kgpb.EntityExposureRequest) (*kgpb.EntityExposureResponse, error) {
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	rows, err := s.g.EntityExposure(ctx, req.Bvids, req.Limit)
	if err != nil {
		return nil, internal("entity exposure", err)
	}
	out := make([]*kgpb.ExposureRow, 0, len(rows))
	for _, r := range rows {
		var samples []*kgpb.ExposureEvidence
		if raw, ok := r["evidence_sample"].([]any); ok {
			for _, item := range raw {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				samples = append(samples, &kgpb.ExposureEvidence{
					Bvid:      str(m["bvid"]),
					PageIndex: int32(i64(m["page_index"])),
					Quote:     str(m["quote"]),
				})
			}
		}
		out = append(out, &kgpb.ExposureRow{
			Eid:            str(r["eid"]),
			Name:           str(r["name"]),
			Type:           str(r["type"]),
			Description:    str(r["description"]),
			Pages:          i64(r["pages"]),
			EvidenceSample: samples,
		})
	}
	return &kgpb.EntityExposureResponse{Rows: out}, nil
}

func (s *Server) EntityAppearances(ctx context.Context, req *kgpb.EntityAppearancesRequest) (*kgpb.EntityAppearancesResponse, error) {
	if req.Eid == "" {
		return nil, invalid("eid is required")
	}
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	rows, err := s.g.EntityAppearances(ctx, req.Eid, req.Bvids, req.Limit)
	if err != nil {
		return nil, internal("entity appearances", err)
	}
	out := make([]*kgpb.AppearanceRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.AppearanceRow{
			Bvid:      str(r["bvid"]),
			PageIndex: int32(i64(r["page_index"])),
			Quote:     str(r["quote"]),
		})
	}
	return &kgpb.EntityAppearancesResponse{Rows: out}, nil
}

func (s *Server) TopEntities(ctx context.Context, req *kgpb.TopEntitiesRequest) (*kgpb.TopEntitiesResponse, error) {
	if req.Limit <= 0 {
		return nil, invalid("limit must be positive")
	}
	rows, err := s.g.TopEntities(ctx, req.Limit)
	if err != nil {
		return nil, internal("top entities", err)
	}
	out := make([]*kgpb.TopEntityRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.TopEntityRow{
			Eid:         str(r["eid"]),
			Name:        str(r["name"]),
			Type:        str(r["type"]),
			Description: str(r["description"]),
			Degree:      i64(r["degree"]),
		})
	}
	return &kgpb.TopEntitiesResponse{Rows: out}, nil
}

func (s *Server) EdgesAmong(ctx context.Context, req *kgpb.EdgesAmongRequest) (*kgpb.EdgesAmongResponse, error) {
	rows, err := s.g.EdgesAmong(ctx, req.Eids)
	if err != nil {
		return nil, internal("edges among", err)
	}
	out := make([]*kgpb.EdgeRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.EdgeRow{
			SrcEid:  str(r["src_eid"]),
			DstEid:  str(r["dst_eid"]),
			RelType: str(r["rel_type"]),
		})
	}
	return &kgpb.EdgesAmongResponse{Rows: out}, nil
}

func (s *Server) Stats(ctx context.Context, req *kgpb.StatsRequest) (*kgpb.StatsResponse, error) {
	gs, err := s.g.Stats(ctx)
	if err != nil {
		return nil, internal("stats", err)
	}
	pending, err := db.CountPendingPages(ctx)
	if err != nil {
		slog.Warn("[KG_GRPC] pending count failed", "err", err)
	}
	return &kgpb.StatsResponse{
		Entities:     gs.Entities,
		Relations:    gs.Relations,
		Evidence:     gs.Evidence,
		Videos:       gs.Videos,
		PendingPages: pending,
	}, nil
}

// ── helpers ──────────────────────────────────────────────────────────

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}

func i64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case nil:
		return 0
	default:
		return 0
	}
}

func strList(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// requestIDFromContext reads the gateway/caller-generated request id
// (grpc metadata "x-request-id") for log correlation.
func requestIDFromContext(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	values := md.Get("x-request-id")
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

// Interceptor returns the unary server chain: request-id correlation +
// structured access log + panic recovery. Neo4j/MySQL unavailability
// surfaces as codes.Internal with the operation name (the app-ts side
// degrades or fails the build page — never the whole service).
func Interceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler,
	) (resp any, err error) {
		requestID := requestIDFromContext(ctx)
		if requestID == "" {
			requestID = uuid.NewString()
		}
		start := time.Now()
		resp, err = handler(ctx, req)
		attrs := []slog.Attr{
			slog.String("module", "grpc"),
			slog.String("method", info.FullMethod),
			slog.Duration("latency", time.Since(start)),
			slog.String("request_id", requestID),
		}
		if err != nil {
			attrs = append(attrs, slog.String("err", err.Error()))
			slog.LogAttrs(ctx, slog.LevelWarn, "grpc request failed", attrs...)
		} else {
			slog.LogAttrs(ctx, slog.LevelInfo, "grpc request", attrs...)
		}
		return resp, err
	}
}
