// Package graph — the complete Neo4j data access for the KG domain, a
// method-by-method port of app/repository/kg_graph_repository.py. Cypher
// semantics must stay byte-compatible with the Python implementation: during
// the transition both stacks write the SAME graph (shared Neo4j, merge keys
// name_lower/bvid, deterministic eid = sha1(name_lower)[:16] computed by the
// CALLER — this package never normalizes names).
//
// Graph schema (unchanged):
//
//	(:Entity {eid, name, name_lower, type, description, aliases,
//	          mention_count, created_at, updated_at})
//	(:Video  {bvid})
//	(a:Entity)-[:RELATES    {rel_type, weight, quotes}]->(b:Entity)
//	(e:Entity)-[:APPEARS_IN {page_index, quote}]->(v:Video)
package graph

import (
	"context"
	"fmt"
	"log/slog"

	"app-kg/internal/neo4jstore"
)

// MaxRelationQuotes caps the evidence quotes kept per RELATES edge (parity
// with the Python MAX_RELATION_QUOTES).
const MaxRelationQuotes = 3

// Store executes Cypher against the configured database.
type Store struct {
	st *neo4jstore.Store
}

// New wires the graph store onto the neo4jstore handle.
func New(st *neo4jstore.Store) *Store { return &Store{st: st} }

// run executes a query and collects all records as value maps.
func (g *Store) run(ctx context.Context, cypher string, params map[string]any) ([]map[string]any, error) {
	session := g.st.NewSession(ctx)
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
func (g *Store) UpsertEntities(ctx context.Context, rows []map[string]any) ([]string, error) {
	if len(rows) == 0 {
		return nil, nil
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
	res, err := g.run(ctx, cypher, map[string]any{"rows": rows})
	if err != nil {
		return nil, err
	}
	eids := make([]string, 0, len(res))
	for _, r := range res {
		eids = append(eids, asString(r["eid"]))
	}
	return eids, nil
}

// LinkAppearances writes APPEARS_IN evidence edges for (bvid, page_index).
// Same-page duplicates are resolved to the shortest non-empty quote (more
// focused), mirroring the Python dedup. Returns the linked edge count.
func (g *Store) LinkAppearances(ctx context.Context, bvid string, pageIndex int32, appearances []map[string]any) (int64, error) {
	dedup := map[string]string{}
	var order []string
	for _, a := range appearances {
		eid, _ := a["eid"].(string)
		if eid == "" {
			continue
		}
		quote, _ := a["quote"].(string)
		cur, ok := dedup[eid]
		if !ok {
			order = append(order, eid)
			dedup[eid] = quote
			continue
		}
		if quote != "" && (cur == "" || len(quote) < len(cur)) {
			dedup[eid] = quote
		}
	}
	if len(order) == 0 {
		return 0, nil
	}
	rows := make([]map[string]any, 0, len(order))
	for _, eid := range order {
		rows = append(rows, map[string]any{"eid": eid, "quote": dedup[eid]})
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
	res, err := g.run(ctx, cypher, map[string]any{
		"bvid": bvid, "page_index": pageIndex, "rows": rows,
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
func (g *Store) UpsertRelations(ctx context.Context, relations []map[string]any) error {
	seen := map[string]bool{}
	rows := make([]map[string]any, 0, len(relations))
	for _, rel := range relations {
		key := asString(rel["src_eid"]) + "|" + asString(rel["dst_eid"]) + "|" + asString(rel["rel_type"])
		if seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, rel)
	}
	if len(rows) == 0 {
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
	_, err := g.run(ctx, cypher, map[string]any{"rows": rows, "max_quotes": MaxRelationQuotes})
	return err
}

// ── deletion / cleanup ───────────────────────────────────────────────

// DeletePageEvidence removes all evidence edges of one page
// (delete-before-write). Returns the deleted edge count.
func (g *Store) DeletePageEvidence(ctx context.Context, bvid string, pageIndex int32) (int64, error) {
	cypher := `
MATCH (:Video {bvid: $bvid})<-[ev:APPEARS_IN]-(:Entity)
WHERE ev.page_index = $page_index
DELETE ev
RETURN count(ev) AS deleted`
	res, err := g.run(ctx, cypher, map[string]any{"bvid": bvid, "page_index": pageIndex})
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return asInt64(res[0]["deleted"]), nil
}

// DeleteVideo cascades all graph traces of a video and collects orphan
// nodes. Returns {entitiesRemoved, videosRemoved}.
func (g *Store) DeleteVideo(ctx context.Context, bvid string) (entitiesRemoved, videosRemoved int64, err error) {
	session := g.st.NewSession(ctx)
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
func (g *Store) ClearAll(ctx context.Context) error {
	_, err := g.run(ctx, "MATCH (n) WHERE n:Entity OR n:Video DETACH DELETE n", nil)
	if err != nil {
		return err
	}
	slog.Warn("[KG_REPO] graph cleared (all Entity/Video nodes)")
	return nil
}

// ── retrieval reads ──────────────────────────────────────────────────

// Neighbors is the one-hop BFS expansion: neighbour entities of the frontier
// eids with their connecting relation info.
func (g *Store) Neighbors(ctx context.Context, eids, excludeEids []string, limit int32) ([]map[string]any, error) {
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
	return g.run(ctx, cypher, map[string]any{
		"eids": eids, "exclude": excludeEids, "limit": limit,
	})
}

// FetchEvidence pulls APPEARS_IN evidence rows; empty bvids = no scope
// filter (admin/debug semantics, mirroring the Python repository).
func (g *Store) FetchEvidence(ctx context.Context, eids, bvids []string, limit int32) ([]map[string]any, error) {
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
	return g.run(ctx, cypher, map[string]any{
		"eids": eids, "bvids": bvids, "limit": limit,
	})
}

// RelationsAmong returns the relation edges between subgraph members.
func (g *Store) RelationsAmong(ctx context.Context, eids []string) ([]map[string]any, error) {
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
	return g.run(ctx, cypher, map[string]any{"eids": eids})
}

// EntitiesByEids fetches entity details.
func (g *Store) EntitiesByEids(ctx context.Context, eids []string) ([]map[string]any, error) {
	if len(eids) == 0 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (e:Entity {eid: eid})
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       e.description AS description, coalesce(e.aliases, []) AS aliases`
	return g.run(ctx, cypher, map[string]any{"eids": eids})
}

// EntityExposure aggregates APPEARS_IN page counts per entity within scope
// (blindspot map). Empty bvids returns nil — callers must pass a scope
// (different from FetchEvidence where empty means "no filter").
func (g *Store) EntityExposure(ctx context.Context, bvids []string, limit int32) ([]map[string]any, error) {
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
	return g.run(ctx, cypher, map[string]any{"bvids": bvids, "limit": limit})
}

// EntityAppearances lists all appearances of one entity.
func (g *Store) EntityAppearances(ctx context.Context, eid string, bvids []string, limit int32) ([]map[string]any, error) {
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
	return g.run(ctx, cypher, map[string]any{"eid": eid, "bvids": bvids, "limit": limit})
}

// TopEntities ranks head entities by RELATES degree (overview mode).
func (g *Store) TopEntities(ctx context.Context, limit int32) ([]map[string]any, error) {
	cypher := `
MATCH (e:Entity)-[r:RELATES]-()
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       e.description AS description, count(r) AS degree
ORDER BY degree DESC
LIMIT $limit`
	return g.run(ctx, cypher, map[string]any{"limit": limit})
}

// EdgesAmong returns directed relation edges inside an entity set (undirected
// dedup is the caller's job).
func (g *Store) EdgesAmong(ctx context.Context, eids []string) ([]map[string]any, error) {
	if len(eids) < 2 {
		return nil, nil
	}
	cypher := `
UNWIND $eids AS eid
MATCH (a:Entity {eid: eid})-[r:RELATES]->(b:Entity)
WHERE b.eid IN $eids
RETURN DISTINCT a.eid AS src_eid, b.eid AS dst_eid,
       r.rel_type AS rel_type`
	return g.run(ctx, cypher, map[string]any{"eids": eids})
}

// GraphStats holds the Neo4j-side counters (service.stats composition adds
// Milvus + pending counts at the caller).
type GraphStats struct {
	Entities  int64
	Relations int64
	Evidence  int64
	Videos    int64
}

// Stats returns the four graph counters. CALL () { ... } scope clauses are
// required on Neo4j 5.23+ (bare CALL {} deprecated) — same as Python.
func (g *Store) Stats(ctx context.Context) (GraphStats, error) {
	cypher := `
CALL () {
    MATCH (e:Entity) RETURN count(e) AS entities
}
CALL () {
    MATCH ()-[r:RELATES]->() RETURN count(r) AS relations
}
CALL () {
    MATCH ()-[a:APPEARS_IN]->() RETURN count(a) as evidence
}
CALL () {
    MATCH (v:Video) RETURN count(v) AS videos
}
RETURN entities, relations, evidence, videos`
	res, err := g.run(ctx, cypher, nil)
	if err != nil {
		return GraphStats{}, err
	}
	var out GraphStats
	if len(res) > 0 {
		out.Entities = asInt64(res[0]["entities"])
		out.Relations = asInt64(res[0]["relations"])
		out.Evidence = asInt64(res[0]["evidence"])
		out.Videos = asInt64(res[0]["videos"])
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
