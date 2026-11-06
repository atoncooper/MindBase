package grpc

import (
	"context"
	"errors"

	"app-kg/internal/kgpb"
	"app-kg/internal/service"
)

// 记账（MySQL）──────────────────────────────────────────────────────────

func (s *Server) ResolveScope(ctx context.Context, req *kgpb.ResolveScopeRequest) (*kgpb.ResolveScopeResponse, error) {
	bvids, err := s.kg.ResolveScope(ctx, req.Uid, req.FolderIds)
	if err != nil {
		return nil, mapError("resolve scope", err)
	}
	if bvids == nil {
		bvids = []string{}
	}
	return &kgpb.ResolveScopeResponse{Bvids: bvids}, nil
}

func (s *Server) SelectPendingPages(ctx context.Context, req *kgpb.SelectPendingPagesRequest) (*kgpb.SelectPendingPagesResponse, error) {
	pages, err := s.kg.SelectPendingPages(ctx, req.Bvids, req.Limit)
	if err != nil {
		return nil, mapError("select pending pages", err)
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
	var expected *int64
	if req.ExpectedVersion >= 0 {
		v := req.ExpectedVersion
		expected = &v
	}
	res, err := s.kg.BeginPage(ctx, req.Bvid, req.Cid, expected)
	if err != nil {
		if errors.Is(err, service.ErrPageNotFound) {
			return &kgpb.BeginPageResponse{Found: false, Reason: res.Reason}, nil
		}
		return nil, mapError("begin page", err)
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
	if err := s.kg.MarkPageDone(ctx, req.Bvid, req.Cid, req.ContentVersion); err != nil {
		return nil, mapError("mark page done", err)
	}
	return &kgpb.MarkPageDoneResponse{}, nil
}

func (s *Server) MarkPageFailed(ctx context.Context, req *kgpb.MarkPageFailedRequest) (*kgpb.MarkPageFailedResponse, error) {
	if err := s.kg.MarkPageFailed(ctx, req.Bvid, req.Cid); err != nil {
		return nil, mapError("mark page failed", err)
	}
	return &kgpb.MarkPageFailedResponse{}, nil
}

func (s *Server) CountPendingPages(ctx context.Context, req *kgpb.CountPendingPagesRequest) (*kgpb.CountPendingPagesResponse, error) {
	n, err := s.kg.CountPendingPages(ctx)
	if err != nil {
		return nil, mapError("count pending pages", err)
	}
	return &kgpb.CountPendingPagesResponse{Count: n}, nil
}
