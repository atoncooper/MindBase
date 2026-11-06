package grpc

import (
	"context"

	"app-kg/internal/kgpb"
	"app-kg/internal/service"
)

// 图写（Neo4j）──────────────────────────────────────────────────────────

func (s *Server) UpsertEntities(ctx context.Context, req *kgpb.UpsertEntitiesRequest) (*kgpb.UpsertEntitiesResponse, error) {
	entities := make([]service.EntityInput, 0, len(req.Entities))
	for _, e := range req.Entities {
		entities = append(entities, service.EntityInput{
			Eid: e.Eid, Name: e.Name, NameLower: e.NameLower,
			Type: e.Type, Description: e.Description, Alias: e.Alias,
		})
	}
	eids, err := s.kg.UpsertEntities(ctx, entities)
	if err != nil {
		return nil, mapError("upsert entities", err)
	}
	if eids == nil {
		eids = []string{}
	}
	return &kgpb.UpsertEntitiesResponse{Eids: eids}, nil
}

func (s *Server) LinkAppearances(ctx context.Context, req *kgpb.LinkAppearancesRequest) (*kgpb.LinkAppearancesResponse, error) {
	appearances := make([]service.AppearanceInput, 0, len(req.Appearances))
	for _, a := range req.Appearances {
		appearances = append(appearances, service.AppearanceInput{Eid: a.Eid, Quote: a.Quote})
	}
	linked, err := s.kg.LinkAppearances(ctx, req.Bvid, req.PageIndex, appearances)
	if err != nil {
		return nil, mapError("link appearances", err)
	}
	return &kgpb.LinkAppearancesResponse{Linked: linked}, nil
}

func (s *Server) UpsertRelations(ctx context.Context, req *kgpb.UpsertRelationsRequest) (*kgpb.UpsertRelationsResponse, error) {
	relations := make([]service.RelationInput, 0, len(req.Relations))
	for _, r := range req.Relations {
		relations = append(relations, service.RelationInput{
			SrcEid: r.SrcEid, DstEid: r.DstEid,
			RelType: r.RelType, Quote: r.Quote,
		})
	}
	if err := s.kg.UpsertRelations(ctx, relations); err != nil {
		return nil, mapError("upsert relations", err)
	}
	return &kgpb.UpsertRelationsResponse{}, nil
}

func (s *Server) DeletePageEvidence(ctx context.Context, req *kgpb.DeletePageEvidenceRequest) (*kgpb.DeletePageEvidenceResponse, error) {
	deleted, err := s.kg.DeletePageEvidence(ctx, req.Bvid, req.PageIndex)
	if err != nil {
		return nil, mapError("delete page evidence", err)
	}
	return &kgpb.DeletePageEvidenceResponse{Deleted: deleted}, nil
}

func (s *Server) DeleteVideo(ctx context.Context, req *kgpb.DeleteVideoRequest) (*kgpb.DeleteVideoResponse, error) {
	entitiesRemoved, videosRemoved, err := s.kg.DeleteVideo(ctx, req.Bvid)
	if err != nil {
		return nil, mapError("delete video", err)
	}
	return &kgpb.DeleteVideoResponse{EntitiesRemoved: entitiesRemoved, VideosRemoved: videosRemoved}, nil
}

func (s *Server) ClearAll(ctx context.Context, req *kgpb.ClearAllRequest) (*kgpb.ClearAllResponse, error) {
	if err := s.kg.ClearAll(ctx); err != nil {
		return nil, mapError("clear all", err)
	}
	return &kgpb.ClearAllResponse{}, nil
}
