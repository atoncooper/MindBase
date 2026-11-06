package grpc

import (
	"context"

	"app-kg/internal/kgpb"
	"app-kg/internal/service"
)

// 云盘知识点（CloudDoc knowledge）──────────────────────────────────────
// 与视频共用 Entity/RELATES 空间；证据边目标是 CloudDoc 节点（无 page_index）。

func (s *Server) LinkCloudDocAppearances(ctx context.Context, req *kgpb.LinkCloudDocAppearancesRequest) (*kgpb.LinkCloudDocAppearancesResponse, error) {
	appearances := make([]service.AppearanceInput, 0, len(req.Appearances))
	for _, a := range req.Appearances {
		appearances = append(appearances, service.AppearanceInput{Eid: a.Eid, Quote: a.Quote})
	}
	linked, err := s.kg.LinkCloudDocAppearances(ctx, req.Uid, req.UploadUuid, req.Title, req.ContentHash, appearances)
	if err != nil {
		return nil, mapError("link cloud doc appearances", err)
	}
	return &kgpb.LinkCloudDocAppearancesResponse{Linked: linked}, nil
}

func (s *Server) DeleteCloudDocAppearances(ctx context.Context, req *kgpb.DeleteCloudDocAppearancesRequest) (*kgpb.DeleteCloudDocAppearancesResponse, error) {
	deleted, entitiesRemoved, err := s.kg.DeleteCloudDocAppearances(ctx, req.Uid, req.UploadUuid)
	if err != nil {
		return nil, mapError("delete cloud doc appearances", err)
	}
	return &kgpb.DeleteCloudDocAppearancesResponse{Deleted: deleted, EntitiesRemoved: entitiesRemoved}, nil
}

func (s *Server) FetchCloudDocEvidence(ctx context.Context, req *kgpb.FetchCloudDocEvidenceRequest) (*kgpb.FetchCloudDocEvidenceResponse, error) {
	rows, err := s.kg.FetchCloudDocEvidence(ctx, req.Eids, req.Uid, req.UploadUuids, req.Limit)
	if err != nil {
		return nil, mapError("fetch cloud doc evidence", err)
	}
	out := make([]*kgpb.CloudDocEvidenceRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.CloudDocEvidenceRow{
			Eid:        r.Eid,
			Name:       r.Name,
			Type:       r.Type,
			UploadUuid: r.UploadUUID,
			Quote:      r.Quote,
			Title:      r.Title,
		})
	}
	return &kgpb.FetchCloudDocEvidenceResponse{Rows: out}, nil
}
