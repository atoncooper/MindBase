// Package neo4j is the Cypher data-access layer of app-kg: every statement
// that reads or writes the knowledge graph lives here. It never validates
// business input and never speaks gRPC/HTTP — internal/service owns the
// rules, internal/infra/neo4j owns the driver.
//
// Cypher semantics must stay compatible with the retired Python
// KgGraphRepository (the guard tests pin the merge keys and the quotes
// sliding window): merge keys name_lower / bvid, deterministic
// eid = sha1(name_lower)[:16] computed by the CALLER — this package never
// normalizes names.
//
// Graph schema (unchanged):
//
//	(:Entity {eid, name, name_lower, type, description, aliases,
//	          mention_count, created_at, updated_at})
//	(:Video  {bvid})
//	(a:Entity)-[:RELATES    {rel_type, weight, quotes}]->(b:Entity)
//	(e:Entity)-[:APPEARS_IN {page_index, quote}]->(v:Video)
package neo4j

import (
	"context"
	"fmt"
	"log/slog"

	neostore "app-kg/internal/infra/neo4j"
)

// MaxRelationQuotes caps the evidence quotes kept per RELATES edge (parity
// with the Python MAX_RELATION_QUOTES).
const MaxRelationQuotes = 3

// GraphRepo executes Cypher against the configured Neo4j database.
type GraphRepo struct {
	st *neostore.Store
}

// New wires the graph repository onto the infra handle.
func New(st *neostore.Store) *GraphRepo { return &GraphRepo{st: st} }

// ── inputs (typed Cypher parameters) ────────────────────────────────

// EntityInput is one entity upsert row. Normalization (name_lower / eid) is
// the caller's job and arrives precomputed.
type EntityInput struct {
	Eid         string
	Name        string
	NameLower   string
	Type        string
	Description string
	Alias       string
}

// AppearanceInput is one APPEARS_IN evidence link.
type AppearanceInput struct {
	Eid   string
	Quote string
}

// RelationInput is one RELATES edge row.
type RelationInput struct {
	SrcEid  string
	DstEid  string
	RelType string
	Quote   string
}

// ── read models (typed Cypher row projections) ──────────────────────

// Neighbor is one hop of the BFS expansion.
type Neighbor struct {
	Eid         string
	Name        string
	Type        string
	Description string
	RelType     string
	FromEid     string
}

// Evidence is one APPEARS_IN row. PageTitle is filled by the service layer
// (video-table join), never by Cypher.
type Evidence struct {
	Eid       string
	Name      string
	Type      string
	Bvid      string
	PageIndex int32
	Quote     string
	PageTitle string
}

// Relation is one RELATES edge between subgraph members.
type Relation struct {
	SrcEid  string
	SrcName string
	RelType string
	DstEid  string
	DstName string
	Weight  int64
	Quotes  []string
}

// Entity is one entity's detail projection.
type Entity struct {
	Eid         string
	Name        string
	Type        string
	Description string
	Aliases     []string
}

// ExposureEvidence is one sampled appearance of an over-exposed entity.
type ExposureEvidence struct {
	Bvid      string
	PageIndex int32
	Quote     string
}

// Exposure is one row of the blindspot exposure aggregation.
type Exposure struct {
	Eid            string
	Name           string
	Type           string
	Description    string
	Pages          int64
	EvidenceSample []ExposureEvidence
}

// Appearance is one appearance of a single entity.
type Appearance struct {
	Bvid      string
	PageIndex int32
	Quote     string
}

// TopEntity is one head entity ranked by RELATES degree.
type TopEntity struct {
	Eid         string
	Name        string
	Type        string
	Description string
	Degree      int64
}

// Edge is one directed relation edge inside an entity set.
type Edge struct {
	SrcEid  string
	DstEid  string
	RelType string
}

// GraphStats holds the Neo4j-side counters (the service composes the Milvus /
// pending-page counters on top). Evidence is video-only; cloud-document
// knowledge evidence is reported separately so the video stats stay comparable.
type GraphStats struct {
	Entities      int64
	Relations     int64
	Evidence      int64
	Videos        int64
	CloudDocs     int64
	CloudEvidence int64
}

// run executes a query and collects all records as value maps. Map rows stay
// private to this package — methods return typed projections instead.
func (r *GraphRepo) run(ctx context.Context, cypher string, params map[string]any) ([]map[string]any, error) {
	session := r.st.NewSession(ctx)
	defer session.Close(ctx)
	result, err := session.Run(ctx, cypher, params)
	if err != nil {
		return nil, err
	}
	records, err := result.Collect(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		row := make(map[string]any, len(rec.Keys))
		for i, key := range rec.Keys {
			row[key] = rec.Values[i]
		}
		out = append(out, row)
	}
	return out, nil
}

// ── entity / video / evidence / relation writes ──────────────────────

// UpsertEntities bulk-MERGEs entities (merge key name_lower). Description is
// only overwritten when the incoming value is non-empty (stub rows must not
// clear existing descriptions); mention_count increments per upsert; alias is
// appended when new. Returns all involved eids.
func (r *GraphRepo) UpsertEntities(ctx context.Context, rows []EntityInput) ([]string, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	params := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		params = append(params, map[string]any{
			"eid": row.Eid, "name": row.Name, "name_lower": row.NameLower,
			"type": row.Type, "description": row.Description, "alias": row.Alias,
		})
	}
	cypher := `
UNWIND $rows AS row
MERGE (e:Entity {name_lower: row.name_lower})
ON CREATE SET e.eid = row.eid, e.created_at = timestamp(),
              e.aliases = [], e.mention_count = 0
SET e.name = row.name,
    e.updated_at = timestamp(),
    e.type = CASE WHEN coalesce(row.type,'') <> ''
                  THEN row.type ELSE coalesce(e.type, 'other') END,
    e.description = CASE WHEN coalesce(row.description,'') <> ''
                         THEN row.description ELSE coalesce(e.description,'') END,
    e.mention_count = coalesce(e.mention_count, 0) + 1
FOREACH (_ IN CASE WHEN coalesce(row.alias,'') <> ''
                    AND NOT row.alias IN coalesce(e.aliases, [])
                   THEN [1] ELSE [] END |
  SET e.aliases = coalesce(e.aliases, []) + row.alias
)
RETURN DISTINCT e.eid AS eid`
	res, err := r.run(ctx, cypher, map[string]any{"rows": params})
	if err != nil {
		return nil, err
	}
	eids := make([]string, 0, len(res))
	for _, row := range res {
		eids = append(eids, asString(row["eid"]))
	}
	return eids, nil
}

// LinkAppearances writes APPEARS_IN evidence edges for (bvid, page_index).
// Same-page duplicates are resolved to the shortest non-empty quote (more
// focused), mirroring the Python dedup. Returns the linked edge count.
func (r *GraphRepo) LinkAppearances(ctx context.Context, bvid string, pageIndex int32, appearances []AppearanceInput) (int64, error) {
	dedup := map[string]string{}
	var order []string
	for _, a := range appearances {
		if a.Eid == "" {
			continue
		}
		cur, ok := dedup[a.Eid]
		if !ok {
			order = append(order, a.Eid)
			dedup[a.Eid] = a.Quote
			continue
		}
		if a.Quote != "" && (cur == "" || len(a.Quote) < len(cur)) {
			dedup[a.Eid] = a.Quote
		}
	}
	if len(order) == 0 {
		return 0, nil
	}
	params := make([]map[string]any, 0, len(order))
	for _, eid := range order {
		params = append(params, map[string]any{"eid": eid, "quote": dedup[eid]})
	}
	cypher := `
MERGE (v:Video {bvid: $bvid})
WITH v
UNWIND $rows AS row
MATCH (e:Entity {eid: row.eid})
MERGE (e)-[ev:APPEARS_IN {page_index: $page_index}]->(v)
ON CREATE SET ev.created_at = timestamp()
SET ev.quote = row.quote, ev.updated_at = timestamp()
RETURN count(ev) AS linked`
	res, err := r.run(ctx, cypher, map[string]any{
		"bvid": bvid, "page_index": pageIndex, "rows": params,
	})
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return asInt64(res[0]["linked"]), nil
}

// UpsertRelations bulk-MERGEs RELATES edges: weight increments, quotes keep
// the most recent dedup samples within MaxRelationQuotes.
func (r *GraphRepo) UpsertRelations(ctx context.Context, relations []RelationInput) error {
	seen := map[string]bool{}
	params := make([]map[string]any, 0, len(relations))
	for _, rel := range relations {
		key := rel.SrcEid + "|" + rel.DstEid + "|" + rel.RelType
		if seen[key] {
			continue
		}
		seen[key] = true
		params = append(params, map[string]any{
			"src_eid": rel.SrcEid, "dst_eid": rel.DstEid,
			"rel_type": rel.RelType, "quote": rel.Quote,
		})
	}
	if len(params) == 0 {
		return nil
	}
	cypher := `
UNWIND $rows AS row
MATCH (a:Entity {eid: row.src_eid})
MATCH (b:Entity {eid: row.dst_eid})
MERGE (a)-[r:RELATES {rel_type: row.rel_type}]->(b)
SET r.weight = coalesce(r.weight, 0) + 1,
    r.updated_at = timestamp(),
    r.quotes = CASE
        WHEN coalesce(row.quote,'') = '' THEN coalesce(r.quotes, [])
        WHEN row.quote IN coalesce(r.quotes, []) THEN r.quotes
        WHEN size(coalesce(r.quotes, [])) < $max_quotes
            THEN coalesce(r.quotes, []) + row.quote
        ELSE coalesce(r.quotes, [])[1..] + row.quote
    END`
	_, err := r.run(ctx, cypher, map[string]any{"rows": params, "max_quotes": MaxRelationQuotes})
	return err
}

// ── deletion / cleanup ───────────────────────────────────────────────

// DeletePageEvidence removes all evidence edges of one page
// (delete-before-write). Returns the deleted edge count.
func (r *GraphRepo) DeletePageEvidence(ctx context.Context, bvid string, pageIndex int32) (int64, error) {
	cypher := `
MATCH (:Video {bvid: $bvid})<-[ev:APPEARS_IN]-(:Entity)
WHERE ev.page_index = $page_index
DELETE ev
RETURN count(ev) AS deleted`
	res, err := r.run(ctx, cypher, map[string]any{"bvid": bvid, "page_index": pageIndex})
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return asInt64(res[0]["deleted"]), nil
}

// DeleteVideo cascades all graph traces of a video and collects orphan
// nodes. Returns (entitiesRemoved, videosRemoved).
func (r *GraphRepo) DeleteVideo(ctx context.Context, bvid string) (entitiesRemoved, videosRemoved int64, err error) {
	session := r.st.NewSession(ctx)
	defer session.Close(ctx)

	runCount := func(cypher string, params map[string]any) (int64, error) {
		result, err := session.Run(ctx, cypher, params)
		if err != nil {
			return 0, err
		}
		records, err := result.Collect(ctx)
		if err != nil {
			return 0, err
		}
		if len(records) == 0 {
			return 0, nil
		}
		return asInt64(records[0].Values[0]), nil
	}

	videosRemoved, err = runCount(
		"MATCH (v:Video {bvid: $bvid}) DETACH DELETE v RETURN count(v) AS deleted",
		map[string]any{"bvid": bvid})
	if err != nil {
		return 0, 0, err
	}
	entitiesRemoved, err = runCount(
		"MATCH (e:Entity) WHERE NOT (e)--() DELETE e RETURN count(e) AS removed",
		nil)
	if err != nil {
		return 0, 0, err
	}
	videosRemovedExtra, err := runCount(
		"MATCH (v:Video) WHERE NOT ()-[:APPEARS_IN]->(v) DELETE v RETURN count(v) AS removed",
		nil)
	if err != nil {
		return 0, 0, err
	}
	videosRemoved += videosRemovedExtra
	if entitiesRemoved != 0 || videosRemoved != 0 {
		slog.Info("[KG_REPO] delete_video", "bvid", bvid,
			"entities_removed", entitiesRemoved, "videos_removed", videosRemoved)
	}
	return entitiesRemoved, videosRemoved, nil
}

// ClearAll wipes every Entity/Video node (dangerous; admin/test only).
// Nodes with other labels are untouched.
func (r *GraphRepo) ClearAll(ctx context.Context) error {
	if _, err := r.run(ctx, "MATCH (n) WHERE n:Entity OR n:Video DETACH DELETE n", nil); err != nil {
		return err
	}
	slog.Warn("[KG_REPO] graph cleared (all Entity/Video nodes)")
	return nil
}

// ── retrieval reads ──────────────────────────────────────────────────

// Neighbors is the one-hop BFS expansion: neighbour entities of the frontier
// eids with their connecting relation info.
func (r *GraphRepo) Neighbors(ctx context.Context, eids, excludeEids []string, limit int32) ([]Neighbor, error) {
	if len(eids) == 0 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (e:Entity {eid: eid})-[r:RELATES]-(n:Entity)
WHERE n.eid <> eid AND NOT n.eid IN $exclude
RETURN DISTINCT n.eid AS eid, n.name AS name, n.type AS type,
       n.description AS description, r.rel_type AS rel_type,
       e.eid AS from_eid
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{
		"eids": eids, "exclude": excludeEids, "limit": limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Neighbor, 0, len(rows))
	for _, row := range rows {
		out = append(out, Neighbor{
			Eid:         asString(row["eid"]),
			Name:        asString(row["name"]),
			Type:        asString(row["type"]),
			Description: asString(row["description"]),
			RelType:     asString(row["rel_type"]),
			FromEid:     asString(row["from_eid"]),
		})
	}
	return out, nil
}

// FetchEvidence pulls APPEARS_IN evidence rows; empty bvids = no scope
// filter (admin/debug semantics, mirroring the Python repository).
func (r *GraphRepo) FetchEvidence(ctx context.Context, eids, bvids []string, limit int32) ([]Evidence, error) {
	if len(eids) == 0 {
		return nil, nil
	}
	if bvids == nil {
		bvids = []string{}
	}
	cypher := `
UNWIND $eids AS eid
MATCH (e:Entity {eid: eid})-[ev:APPEARS_IN]->(v:Video)
WHERE size($bvids) = 0 OR v.bvid IN $bvids
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       v.bvid AS bvid, ev.page_index AS page_index, ev.quote AS quote
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{
		"eids": eids, "bvids": bvids, "limit": limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Evidence, 0, len(rows))
	for _, row := range rows {
		out = append(out, Evidence{
			Eid:       asString(row["eid"]),
			Name:      asString(row["name"]),
			Type:      asString(row["type"]),
			Bvid:      asString(row["bvid"]),
			PageIndex: int32(asInt64(row["page_index"])),
			Quote:     asString(row["quote"]),
		})
	}
	return out, nil
}

// RelationsAmong returns the relation edges between subgraph members.
func (r *GraphRepo) RelationsAmong(ctx context.Context, eids []string) ([]Relation, error) {
	if len(eids) < 2 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (a:Entity {eid: eid})-[r:RELATES]->(b:Entity)
WHERE b.eid IN $eids
RETURN DISTINCT a.eid AS src_eid, a.name AS src_name,
       r.rel_type AS rel_type, b.eid AS dst_eid, b.name AS dst_name,
       coalesce(r.weight, 1) AS weight, coalesce(r.quotes, []) AS quotes`
	rows, err := r.run(ctx, cypher, map[string]any{"eids": eids})
	if err != nil {
		return nil, err
	}
	out := make([]Relation, 0, len(rows))
	for _, row := range rows {
		out = append(out, Relation{
			SrcEid:  asString(row["src_eid"]),
			SrcName: asString(row["src_name"]),
			RelType: asString(row["rel_type"]),
			DstEid:  asString(row["dst_eid"]),
			DstName: asString(row["dst_name"]),
			Weight:  asInt64(row["weight"]),
			Quotes:  asStrings(row["quotes"]),
		})
	}
	return out, nil
}

// EntitiesByEids fetches entity details.
func (r *GraphRepo) EntitiesByEids(ctx context.Context, eids []string) ([]Entity, error) {
	if len(eids) == 0 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (e:Entity {eid: eid})
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       e.description AS description, coalesce(e.aliases, []) AS aliases`
	rows, err := r.run(ctx, cypher, map[string]any{"eids": eids})
	if err != nil {
		return nil, err
	}
	out := make([]Entity, 0, len(rows))
	for _, row := range rows {
		out = append(out, Entity{
			Eid:         asString(row["eid"]),
			Name:        asString(row["name"]),
			Type:        asString(row["type"]),
			Description: asString(row["description"]),
			Aliases:     asStrings(row["aliases"]),
		})
	}
	return out, nil
}

// EntityExposure aggregates APPEARS_IN page counts per entity within scope
// (blindspot map). Empty bvids returns nil — callers must pass a scope
// (different from FetchEvidence where empty means "no filter").
func (r *GraphRepo) EntityExposure(ctx context.Context, bvids []string, limit int32) ([]Exposure, error) {
	if len(bvids) == 0 {
		return nil, nil
	}
	cypher := `
MATCH (e:Entity)-[ev:APPEARS_IN]->(v:Video)
WHERE v.bvid IN $bvids
WITH e, count(ev) AS pages,
     collect({bvid: v.bvid, page_index: ev.page_index, quote: ev.quote})[..5]
     AS evidence_sample
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       e.description AS description,
       pages, evidence_sample
ORDER BY pages DESC
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{"bvids": bvids, "limit": limit})
	if err != nil {
		return nil, err
	}
	out := make([]Exposure, 0, len(rows))
	for _, row := range rows {
		var samples []ExposureEvidence
		if raw, ok := row["evidence_sample"].([]any); ok {
			for _, item := range raw {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				samples = append(samples, ExposureEvidence{
					Bvid:      asString(m["bvid"]),
					PageIndex: int32(asInt64(m["page_index"])),
					Quote:     asString(m["quote"]),
				})
			}
		}
		out = append(out, Exposure{
			Eid:            asString(row["eid"]),
			Name:           asString(row["name"]),
			Type:           asString(row["type"]),
			Description:    asString(row["description"]),
			Pages:          asInt64(row["pages"]),
			EvidenceSample: samples,
		})
	}
	return out, nil
}

// EntityAppearances lists all appearances of one entity.
func (r *GraphRepo) EntityAppearances(ctx context.Context, eid string, bvids []string, limit int32) ([]Appearance, error) {
	if bvids == nil {
		bvids = []string{}
	}
	cypher := `
MATCH (e:Entity {eid: $eid})-[ev:APPEARS_IN]->(v:Video)
WHERE size($bvids) = 0 OR v.bvid IN $bvids
RETURN v.bvid AS bvid, ev.page_index AS page_index,
       ev.quote AS quote
ORDER BY v.bvid, ev.page_index
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{"eid": eid, "bvids": bvids, "limit": limit})
	if err != nil {
		return nil, err
	}
	out := make([]Appearance, 0, len(rows))
	for _, row := range rows {
		out = append(out, Appearance{
			Bvid:      asString(row["bvid"]),
			PageIndex: int32(asInt64(row["page_index"])),
			Quote:     asString(row["quote"]),
		})
	}
	return out, nil
}

// TopEntities ranks head entities by RELATES degree (overview mode).
func (r *GraphRepo) TopEntities(ctx context.Context, limit int32) ([]TopEntity, error) {
	cypher := `
MATCH (e:Entity)-[r:RELATES]-()
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       e.description AS description, count(r) AS degree
ORDER BY degree DESC
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{"limit": limit})
	if err != nil {
		return nil, err
	}
	out := make([]TopEntity, 0, len(rows))
	for _, row := range rows {
		out = append(out, TopEntity{
			Eid:         asString(row["eid"]),
			Name:        asString(row["name"]),
			Type:        asString(row["type"]),
			Description: asString(row["description"]),
			Degree:      asInt64(row["degree"]),
		})
	}
	return out, nil
}

// EdgesAmong returns directed relation edges inside an entity set (undirected
// dedup is the caller's job).
func (r *GraphRepo) EdgesAmong(ctx context.Context, eids []string) ([]Edge, error) {
	if len(eids) < 2 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (a:Entity {eid: eid})-[r:RELATES]->(b:Entity)
WHERE b.eid IN $eids
RETURN DISTINCT a.eid AS src_eid, b.eid AS dst_eid,
       r.rel_type AS rel_type`
	rows, err := r.run(ctx, cypher, map[string]any{"eids": eids})
	if err != nil {
		return nil, err
	}
	out := make([]Edge, 0, len(rows))
	for _, row := range rows {
		out = append(out, Edge{
			SrcEid:  asString(row["src_eid"]),
			DstEid:  asString(row["dst_eid"]),
			RelType: asString(row["rel_type"]),
		})
	}
	return out, nil
}

// Stats returns the four graph counters. CALL () { ... } scope clauses are
// required on Neo4j 5.23+ (bare CALL {} deprecated) — same as Python.
func (r *GraphRepo) Stats(ctx context.Context) (GraphStats, error) {
	cypher := `
CALL () {
    MATCH (e:Entity) RETURN count(e) AS entities
}
CALL () {
    MATCH ()-[r:RELATES]->() RETURN count(r) AS relations
}
CALL () {
    MATCH (:Entity)-[a:APPEARS_IN]->(:Video) RETURN count(a) as evidence
}
CALL () {
    MATCH (v:Video) RETURN count(v) AS videos
}
CALL () {
    MATCH (:Entity)-[:APPEARS_IN]->(d:CloudDoc) RETURN count(DISTINCT d) AS cloud_docs
}
CALL () {
    MATCH (:Entity)-[a:APPEARS_IN]->(:CloudDoc) RETURN count(a) AS cloud_evidence
}
RETURN entities, relations, evidence, videos, cloud_docs, cloud_evidence`
	rows, err := r.run(ctx, cypher, nil)
	if err != nil {
		return GraphStats{}, err
	}
	var out GraphStats
	if len(rows) > 0 {
		out.Entities = asInt64(rows[0]["entities"])
		out.Relations = asInt64(rows[0]["relations"])
		out.Evidence = asInt64(rows[0]["evidence"])
		out.Videos = asInt64(rows[0]["videos"])
		out.CloudDocs = asInt64(rows[0]["cloud_docs"])
		out.CloudEvidence = asInt64(rows[0]["cloud_evidence"])
	}
	return out, nil
}

// ── value coercion helpers ───────────────────────────────────────────

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}

func asInt64(v any) int64 {
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

func asStrings(v any) []string {
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
