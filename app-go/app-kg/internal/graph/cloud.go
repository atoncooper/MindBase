// Cloud-doc routing graph (plan 1.0.15, retrieval layer L1): topic/entity
// nodes for cloud-drive documents, consumed by app-ts's doc routing.
//
// Deliberately SEPARATE label namespace (CloudDoc/CloudTopic/CloudEntity):
// the video KG operations in graph.go (Entity/Video, ClearAll, orphan
// recycling) must never touch cloud documents and vice versa.
//
// Multi-tenant rule: uid sits on EVERY node and every Cypher statement
// filters by it — isolation is enforced here, never by the caller.
// Normalization red line (same as graph.go): name_lower is computed by the
// CALLER; this package never lowercases or hashes names.
package graph

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// CloudDocGraph is one document's routing payload: title plus the topic and
// entity names extracted by the summary stage.
type CloudDocGraph struct {
	UID         int64
	UploadUUID  string
	Title       string
	ContentHash string
	Topics      []string
	Entities    []string
}

// CloudDocMatch is one document hit from MatchCloudDocs.
type CloudDocMatch struct {
	UploadUUID string
	Title      string
	Topics     []string
	Entities   []string
	Score      int
}

func cloudTopicRows(names []string) []map[string]any {
	rows := make([]map[string]any, 0, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		rows = append(rows, map[string]any{"name": n, "name_lower": strings.ToLower(n)})
	}
	return rows
}

// UpsertCloudDocGraph creates/refreshes the doc node, replaces its ABOUT and
// MENTIONS edges (delete-before-write — a recomputed summary must not leave
// stale topic links behind), and recycles nodes left with no incoming edge.
// Orphan cleanup races a concurrent upsert in theory; the next upsert
// recreates any node lost that way, so it self-heals.
func (g *Store) UpsertCloudDocGraph(ctx context.Context, d CloudDocGraph) error {
	// 1. doc node + drop stale edges
	if _, err := g.run(ctx, `
MERGE (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})
ON CREATE SET d.created_at = timestamp()
SET d.title = $title, d.content_hash = $content_hash, d.updated_at = timestamp()
WITH d
OPTIONAL MATCH (d)-[r:ABOUT|MENTIONS]->()
DELETE r
`, map[string]any{
		"uid": d.UID, "upload_uuid": d.UploadUUID,
		"title": d.Title, "content_hash": d.ContentHash,
	}); err != nil {
		return fmt.Errorf("cloud doc upsert: %w", err)
	}
	// 2. topics + ABOUT edges
	if rows := cloudTopicRows(d.Topics); len(rows) > 0 {
		if _, err := g.run(ctx, `
MATCH (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})
UNWIND $rows AS row
MERGE (t:CloudTopic {uid: $uid, name_lower: row.name_lower})
ON CREATE SET t.created_at = timestamp()
SET t.name = row.name, t.updated_at = timestamp()
MERGE (d)-[:ABOUT]->(t)
`, map[string]any{
			"uid": d.UID, "upload_uuid": d.UploadUUID, "rows": rows,
		}); err != nil {
			return fmt.Errorf("cloud topics upsert: %w", err)
		}
	}
	// 3. entities + MENTIONS edges
	if rows := cloudTopicRows(d.Entities); len(rows) > 0 {
		if _, err := g.run(ctx, `
MATCH (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})
UNWIND $rows AS row
MERGE (en:CloudEntity {uid: $uid, name_lower: row.name_lower})
ON CREATE SET en.created_at = timestamp()
SET en.name = row.name, en.updated_at = timestamp()
MERGE (d)-[:MENTIONS]->(en)
`, map[string]any{
			"uid": d.UID, "upload_uuid": d.UploadUUID, "rows": rows,
		}); err != nil {
			return fmt.Errorf("cloud entities upsert: %w", err)
		}
	}
	g.recycleCloudOrphans(ctx)
	return nil
}

// DeleteCloudDocGraph detaches and deletes the doc node (purge / reprocess
// cleanup), then recycles any topic/entity nodes left edge-less.
func (g *Store) DeleteCloudDocGraph(ctx context.Context, uid int64, uploadUUID string) error {
	if _, err := g.run(ctx, `
MATCH (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})
DETACH DELETE d
`, map[string]any{"uid": uid, "upload_uuid": uploadUUID}); err != nil {
		return fmt.Errorf("cloud doc delete: %w", err)
	}
	g.recycleCloudOrphans(ctx)
	return nil
}

// recycleCloudOrphans removes topic/entity nodes no document links to
// anymore. Best-effort: a failure here leaves harmless garbage that the next
// upsert cycle cleans.
func (g *Store) recycleCloudOrphans(ctx context.Context) {
	for _, stmt := range []string{
		`MATCH (t:CloudTopic) WHERE NOT ( ()-[:ABOUT]->(t) ) DETACH DELETE t`,
		`MATCH (en:CloudEntity) WHERE NOT ( ()-[:MENTIONS]->(en) ) DETACH DELETE en`,
	} {
		if _, err := g.run(ctx, stmt, nil); err != nil {
			// logged by the driver layer; nothing actionable here
			return
		}
	}
}

// MatchCloudDocs matches documents by topic/entity name against the given
// keywords (case-insensitive substring in BOTH directions, so short keywords
// still hit longer topic names). Returns docs ordered by distinct-hit score.
func (g *Store) MatchCloudDocs(ctx context.Context, uid int64, keywords []string, limit int) ([]CloudDocMatch, error) {
	keys := make([]string, 0, len(keywords))
	for _, k := range keywords {
		k = strings.ToLower(strings.TrimSpace(k))
		if k != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 || limit <= 0 {
		return nil, nil
	}
	type leg struct {
		cypher string
		field  string
	}
	legs := []leg{
		{
			cypher: `
UNWIND $keys AS k
MATCH (t:CloudTopic {uid: $uid})
WHERE t.name_lower CONTAINS k OR k CONTAINS t.name_lower
MATCH (d:CloudDoc)-[:ABOUT]->(t)
RETURN d.upload_uuid AS upload_uuid, d.title AS title,
       collect(DISTINCT t.name) AS names, count(DISTINCT t) AS score`,
			field: "topics",
		},
		{
			cypher: `
UNWIND $keys AS k
MATCH (en:CloudEntity {uid: $uid})
WHERE en.name_lower CONTAINS k OR k CONTAINS en.name_lower
MATCH (d:CloudDoc)-[:MENTIONS]->(en)
RETURN d.upload_uuid AS upload_uuid, d.title AS title,
       collect(DISTINCT en.name) AS names, count(DISTINCT en) AS score`,
			field: "entities",
		},
	}
	merged := map[string]*CloudDocMatch{}
	var order []string
	for _, lg := range legs {
		res, err := g.run(ctx, lg.cypher, map[string]any{"uid": uid, "keys": keys})
		if err != nil {
			return nil, fmt.Errorf("cloud match %s: %w", lg.field, err)
		}
		for _, r := range res {
			uu := asString(r["upload_uuid"])
			if uu == "" {
				continue
			}
			m, ok := merged[uu]
			if !ok {
				m = &CloudDocMatch{UploadUUID: uu, Title: asString(r["title"])}
				merged[uu] = m
				order = append(order, uu)
			}
			score := 0
			if v, ok := r["score"].(int64); ok {
				score = int(v)
			}
			m.Score += score
			if names, ok := r["names"].([]any); ok {
				for _, n := range names {
					if s, ok := n.(string); ok && s != "" {
						if lg.field == "topics" {
							m.Topics = append(m.Topics, s)
						} else {
							m.Entities = append(m.Entities, s)
						}
					}
				}
			}
		}
	}
	out := make([]CloudDocMatch, 0, len(order))
	for _, uu := range order {
		out = append(out, *merged[uu])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
