package service

import (
	"context"
	"strings"

	neo4jrepo "app-kg/internal/repo/neo4j"
)

// CloudDocService — business rules for the cloud-doc routing graph (plan
// 1.0.15 L1): payload validation + default paging, with the Cypher isolated in
// repo/neo4j. Consumed by the internal JSON endpoints that app-cloud calls.
type CloudDocService struct {
	graph *neo4jrepo.GraphRepo
}

// NewCloudDoc wires the service onto the graph repository.
func NewCloudDoc(graph *neo4jrepo.GraphRepo) *CloudDocService {
	return &CloudDocService{graph: graph}
}

// Domain models are aliases of the repo projections (transports import service
// only).
type (
	CloudDocGraph = neo4jrepo.CloudDocGraph
	CloudDocMatch = neo4jrepo.CloudDocMatch
)

// Upsert creates/refreshes one document's routing graph.
func (s *CloudDocService) Upsert(ctx context.Context, doc CloudDocGraph) error {
	if doc.UID <= 0 || strings.TrimSpace(doc.UploadUUID) == "" {
		return invalidf("uid and upload_uuid are required")
	}
	return s.graph.UpsertCloudDocGraph(ctx, doc)
}

// Delete drops one document's routing graph and recycles orphan topics.
func (s *CloudDocService) Delete(ctx context.Context, uid int64, uploadUUID string) error {
	if uid <= 0 || strings.TrimSpace(uploadUUID) == "" {
		return invalidf("uid and upload_uuid are required")
	}
	return s.graph.DeleteCloudDocGraph(ctx, uid, uploadUUID)
}

// Match matches documents by topic/entity keywords; limit defaults to 10.
func (s *CloudDocService) Match(ctx context.Context, uid int64, keywords []string, limit int) ([]CloudDocMatch, error) {
	if uid <= 0 {
		return nil, invalidf("uid must be positive")
	}
	if limit <= 0 {
		limit = 10
	}
	return s.graph.MatchCloudDocs(ctx, uid, keywords, limit)
}
