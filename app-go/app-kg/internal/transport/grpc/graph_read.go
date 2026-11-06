package grpc

import (
	"context"

	"app-kg/internal/kgpb"
)

// 图读（Neo4j + video 标题 join）─────────────────────────────────────

func (s *Server) Neighbors(ctx context.Context, req *kgpb.NeighborsRequest) (*kgpb.NeighborsResponse, error) {
	rows, err := s.kg.Neighbors(ctx, req.Eids, req.ExcludeEids, req.Limit)
	if err != nil {
		return nil, mapError("neighbors", err)
	}
	out := make([]*kgpb.NeighborRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.NeighborRow{
			Eid:         r.Eid,
			Name:        r.Name,
			Type:        r.Type,
			Description: r.Description,
			RelType:     r.RelType,
			FromEid:     r.FromEid,
		})
	}
	return &kgpb.NeighborsResponse{Rows: out}, nil
}

func (s *Server) FetchEvidence(ctx context.Context, req *kgpb.FetchEvidenceRequest) (*kgpb.FetchEvidenceResponse, error) {
	rows, err := s.kg.FetchEvidence(ctx, req.Eids, req.Bvids, req.Limit)
	if err != nil {
		return nil, mapError("fetch evidence", err)
	}
	out := make([]*kgpb.EvidenceRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.EvidenceRow{
			Eid:       r.Eid,
			Name:      r.Name,
			Type:      r.Type,
			Bvid:      r.Bvid,
			PageIndex: r.PageIndex,
			Quote:     r.Quote,
			PageTitle: r.PageTitle,
		})
	}
	return &kgpb.FetchEvidenceResponse{Rows: out}, nil
}

func (s *Server) RelationsAmong(ctx context.Context, req *kgpb.RelationsAmongRequest) (*kgpb.RelationsAmongResponse, error) {
	rows, err := s.kg.RelationsAmong(ctx, req.Eids)
	if err != nil {
		return nil, mapError("relations among", err)
	}
	out := make([]*kgpb.RelationRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.RelationRow{
			SrcEid:  r.SrcEid,
			SrcName: r.SrcName,
			RelType: r.RelType,
			DstEid:  r.DstEid,
			DstName: r.DstName,
			Weight:  r.Weight,
			Quotes:  r.Quotes,
		})
	}
	return &kgpb.RelationsAmongResponse{Rows: out}, nil
}

func (s *Server) EntitiesByEids(ctx context.Context, req *kgpb.EntitiesByEidsRequest) (*kgpb.EntitiesByEidsResponse, error) {
	rows, err := s.kg.EntitiesByEids(ctx, req.Eids)
	if err != nil {
		return nil, mapError("entities by eids", err)
	}
	out := make([]*kgpb.EntityDetail, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.EntityDetail{
			Eid:         r.Eid,
			Name:        r.Name,
			Type:        r.Type,
			Description: r.Description,
			Aliases:     r.Aliases,
		})
	}
	return &kgpb.EntitiesByEidsResponse{Rows: out}, nil
}

func (s *Server) EntityExposure(ctx context.Context, req *kgpb.EntityExposureRequest) (*kgpb.EntityExposureResponse, error) {
	rows, err := s.kg.EntityExposure(ctx, req.Bvids, req.Limit)
	if err != nil {
		return nil, mapError("entity exposure", err)
	}
	out := make([]*kgpb.ExposureRow, 0, len(rows))
	for _, r := range rows {
		samples := make([]*kgpb.ExposureEvidence, 0, len(r.EvidenceSample))
		for _, e := range r.EvidenceSample {
			samples = append(samples, &kgpb.ExposureEvidence{
				Bvid:      e.Bvid,
				PageIndex: e.PageIndex,
				Quote:     e.Quote,
			})
		}
		out = append(out, &kgpb.ExposureRow{
			Eid:            r.Eid,
			Name:           r.Name,
			Type:           r.Type,
			Description:    r.Description,
			Pages:          r.Pages,
			EvidenceSample: samples,
		})
	}
	return &kgpb.EntityExposureResponse{Rows: out}, nil
}

func (s *Server) EntityAppearances(ctx context.Context, req *kgpb.EntityAppearancesRequest) (*kgpb.EntityAppearancesResponse, error) {
	rows, err := s.kg.EntityAppearances(ctx, req.Eid, req.Bvids, req.Limit)
	if err != nil {
		return nil, mapError("entity appearances", err)
	}
	out := make([]*kgpb.AppearanceRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.AppearanceRow{
			Bvid:      r.Bvid,
			PageIndex: r.PageIndex,
			Quote:     r.Quote,
		})
	}
	return &kgpb.EntityAppearancesResponse{Rows: out}, nil
}

func (s *Server) TopEntities(ctx context.Context, req *kgpb.TopEntitiesRequest) (*kgpb.TopEntitiesResponse, error) {
	rows, err := s.kg.TopEntities(ctx, req.Limit)
	if err != nil {
		return nil, mapError("top entities", err)
	}
	out := make([]*kgpb.TopEntityRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.TopEntityRow{
			Eid:         r.Eid,
			Name:        r.Name,
			Type:        r.Type,
			Description: r.Description,
			Degree:      r.Degree,
		})
	}
	return &kgpb.TopEntitiesResponse{Rows: out}, nil
}

func (s *Server) EdgesAmong(ctx context.Context, req *kgpb.EdgesAmongRequest) (*kgpb.EdgesAmongResponse, error) {
	rows, err := s.kg.EdgesAmong(ctx, req.Eids)
	if err != nil {
		return nil, mapError("edges among", err)
	}
	out := make([]*kgpb.EdgeRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, &kgpb.EdgeRow{
			SrcEid:  r.SrcEid,
			DstEid:  r.DstEid,
			RelType: r.RelType,
		})
	}
	return &kgpb.EdgesAmongResponse{Rows: out}, nil
}

func (s *Server) Stats(ctx context.Context, req *kgpb.StatsRequest) (*kgpb.StatsResponse, error) {
	st, err := s.kg.Stats(ctx)
	if err != nil {
		return nil, mapError("stats", err)
	}
	return &kgpb.StatsResponse{
		Entities:      st.Entities,
		Relations:     st.Relations,
		Evidence:      st.Evidence,
		Videos:        st.Videos,
		PendingPages:  st.PendingPages,
		CloudDocs:     st.CloudDocs,
		CloudEvidence: st.CloudEvidence,
	}, nil
}
