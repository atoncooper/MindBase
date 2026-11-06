package service

import (
	"context"
	"fmt"
	"log/slog"

	mysqlrepo "app-kg/internal/repo/mysql"
)

// This file holds the graph-operation business rules: input validation, the
// cross-store evidence title join, and stats composition. Cypher lives in
// internal/repo/neo4j.

// UpsertEntities validates the normalization contract (eid / name_lower are
// computed by the caller, never here) and bulk-MERGEs the entities.
func (s *KGService) UpsertEntities(ctx context.Context, entities []EntityInput) ([]string, error) {
	for _, e := range entities {
		if e.Name == "" || e.NameLower == "" || e.Eid == "" {
			return nil, invalidf("entity requires eid/name/name_lower (caller computes normalization)")
		}
	}
	return s.graph.UpsertEntities(ctx, entities)
}

// LinkAppearances writes APPEARS_IN evidence edges for one (bvid, page_index).
func (s *KGService) LinkAppearances(ctx context.Context, bvid string, pageIndex int32, appearances []AppearanceInput) (int64, error) {
	if bvid == "" {
		return 0, invalidf("bvid is required")
	}
	return s.graph.LinkAppearances(ctx, bvid, pageIndex, appearances)
}

// UpsertRelations bulk-MERGEs RELATES edges.
func (s *KGService) UpsertRelations(ctx context.Context, relations []RelationInput) error {
	return s.graph.UpsertRelations(ctx, relations)
}

// LinkCloudDocAppearances replaces one cloud document's knowledge evidence
// (delete-before-write is a repository guarantee) and upserts the source node
// metadata. Cloud documents are user-scoped, so uid is mandatory.
func (s *KGService) LinkCloudDocAppearances(ctx context.Context, uid int64, uploadUUID, title, contentHash string, appearances []AppearanceInput) (int64, error) {
	if uid <= 0 {
		return 0, invalidf("uid must be positive")
	}
	if uploadUUID == "" {
		return 0, invalidf("upload_uuid is required")
	}
	return s.graph.LinkCloudDocAppearances(ctx, uid, uploadUUID, title, contentHash, appearances)
}

// DeleteCloudDocAppearances removes one document's knowledge evidence and
// recycles entities left without any relationship.
func (s *KGService) DeleteCloudDocAppearances(ctx context.Context, uid int64, uploadUUID string) (deleted, entitiesRemoved int64, err error) {
	if uid <= 0 {
		return 0, 0, invalidf("uid must be positive")
	}
	if uploadUUID == "" {
		return 0, 0, invalidf("upload_uuid is required")
	}
	return s.graph.DeleteCloudDocAppearances(ctx, uid, uploadUUID)
}

// FetchCloudDocEvidence pulls knowledge evidence from the user's cloud
// documents (uploadUUIDs empty = all of them).
func (s *KGService) FetchCloudDocEvidence(ctx context.Context, eids []string, uid int64, uploadUUIDs []string, limit int32) ([]CloudDocEvidence, error) {
	if uid <= 0 {
		return nil, invalidf("uid must be positive")
	}
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.graph.FetchCloudDocEvidence(ctx, eids, uid, uploadUUIDs, limit)
}

// DeletePageEvidence removes all evidence edges of one page
// (delete-before-write).
func (s *KGService) DeletePageEvidence(ctx context.Context, bvid string, pageIndex int32) (int64, error) {
	if bvid == "" {
		return 0, invalidf("bvid is required")
	}
	return s.graph.DeletePageEvidence(ctx, bvid, pageIndex)
}

// DeleteVideo cascades all graph traces of a video.
func (s *KGService) DeleteVideo(ctx context.Context, bvid string) (entitiesRemoved, videosRemoved int64, err error) {
	if bvid == "" {
		return 0, 0, invalidf("bvid is required")
	}
	return s.graph.DeleteVideo(ctx, bvid)
}

// ClearAll wipes every Entity/Video node (dangerous; admin/test only).
func (s *KGService) ClearAll(ctx context.Context) error {
	return s.graph.ClearAll(ctx)
}

// Neighbors is the one-hop BFS expansion.
func (s *KGService) Neighbors(ctx context.Context, eids, excludeEids []string, limit int32) ([]Neighbor, error) {
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.graph.Neighbors(ctx, eids, excludeEids, limit)
}

// FetchEvidence pulls APPEARS_IN evidence rows and joins the video page
// titles: (bvid, page_index) → page_title, missing → "P{n+1}". The join is a
// business decision (callers must not need a second MySQL round-trip), so it
// lives here rather than in the Cypher repository.
func (s *KGService) FetchEvidence(ctx context.Context, eids, bvids []string, limit int32) ([]Evidence, error) {
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	rows, err := s.graph.FetchEvidence(ctx, eids, bvids, limit)
	if err != nil {
		return nil, err
	}
	bvSet := map[string]bool{}
	for _, row := range rows {
		if row.Bvid != "" {
			bvSet[row.Bvid] = true
		}
	}
	titleBvids := make([]string, 0, len(bvSet))
	for bvid := range bvSet {
		titleBvids = append(titleBvids, bvid)
	}
	titles, err := s.pages.PageTitles(ctx, titleBvids)
	if err != nil {
		slog.Warn("[KG] page title lookup failed", "err", err)
		titles = map[mysqlrepo.PageKey]string{}
	}
	for i := range rows {
		title := titles[mysqlrepo.PageKey{Bvid: rows[i].Bvid, PageIndex: rows[i].PageIndex}]
		if title == "" {
			title = fmt.Sprintf("P%d", rows[i].PageIndex+1)
		}
		rows[i].PageTitle = title
	}
	return rows, nil
}

// RelationsAmong returns the relation edges between subgraph members.
func (s *KGService) RelationsAmong(ctx context.Context, eids []string) ([]Relation, error) {
	return s.graph.RelationsAmong(ctx, eids)
}

// EntitiesByEids fetches entity details.
func (s *KGService) EntitiesByEids(ctx context.Context, eids []string) ([]Entity, error) {
	return s.graph.EntitiesByEids(ctx, eids)
}

// EntityExposure aggregates page exposure per entity within scope
// (blindspot map).
func (s *KGService) EntityExposure(ctx context.Context, bvids []string, limit int32) ([]Exposure, error) {
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.graph.EntityExposure(ctx, bvids, limit)
}

// EntityAppearances lists all appearances of one entity.
func (s *KGService) EntityAppearances(ctx context.Context, eid string, bvids []string, limit int32) ([]Appearance, error) {
	if eid == "" {
		return nil, invalidf("eid is required")
	}
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.graph.EntityAppearances(ctx, eid, bvids, limit)
}

// TopEntities ranks head entities by RELATES degree (overview mode).
func (s *KGService) TopEntities(ctx context.Context, limit int32) ([]TopEntity, error) {
	if limit <= 0 {
		return nil, invalidf("limit must be positive")
	}
	return s.graph.TopEntities(ctx, limit)
}

// EdgesAmong returns directed relation edges inside an entity set.
func (s *KGService) EdgesAmong(ctx context.Context, eids []string) ([]Edge, error) {
	return s.graph.EdgesAmong(ctx, eids)
}

// Stats composes the Neo4j counters with the pending-page counter from MySQL.
// A failed pending count degrades the stats (warn) instead of failing the RPC —
// same behaviour as the historical implementation.
func (s *KGService) Stats(ctx context.Context) (Stats, error) {
	graphStats, err := s.graph.Stats(ctx)
	if err != nil {
		return Stats{}, err
	}
	pending, err := s.pages.CountPending(ctx)
	if err != nil {
		slog.Warn("[KG] pending count failed", "err", err)
	}
	return Stats{
		Entities:      graphStats.Entities,
		Relations:     graphStats.Relations,
		Evidence:      graphStats.Evidence,
		Videos:        graphStats.Videos,
		PendingPages:  pending,
		CloudDocs:     graphStats.CloudDocs,
		CloudEvidence: graphStats.CloudEvidence,
	}, nil
}
