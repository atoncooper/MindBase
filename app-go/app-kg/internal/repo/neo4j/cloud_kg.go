package neo4j

import (
	"context"
	"fmt"
	"log/slog"
)

// ── cloud-doc knowledge (Entity/RELATES shared with the video KG) ────
//
// Cloud-document knowledge points live in the SAME Entity/RELATES space as the
// video KG; only the evidence target differs:
//
//	(e:Entity)-[:APPEARS_IN {quote}]->(d:CloudDoc {uid, upload_uuid, title, content_hash})
//
// The CloudDoc node is created by the cloud-drive L1 routing graph (see
// cloud.go) and reused here as the knowledge source node. Multi-tenant rule:
// every statement filters by d.uid — isolation is enforced here, never by the
// caller. Normalization red line: eid/name arrive precomputed; this package
// never normalizes names.

// CloudDocEvidence is one APPEARS_IN row from an Entity to a CloudDoc source.
type CloudDocEvidence struct {
	Eid        string
	Name       string
	Type       string
	UploadUUID string
	Quote      string
	Title      string
}

// LinkCloudDocAppearances replaces one document's knowledge evidence
// (delete-before-write): MERGE the CloudDoc source node (title/content_hash
// only overwrite when non-empty, so routing metadata survives an empty
// payload), drop the document's existing evidence edges, then write
// (entity)-[:APPEARS_IN {quote}]->(cloudDoc). Same-document duplicates resolve
// to the shortest non-empty quote (parity with LinkAppearances); there is no
// page index — the document is the unit. Returns the linked edge count.
func (r *GraphRepo) LinkCloudDocAppearances(ctx context.Context, uid int64, uploadUUID, title, contentHash string, appearances []AppearanceInput) (int64, error) {
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
	rows := make([]map[string]any, 0, len(order))
	for _, eid := range order {
		rows = append(rows, map[string]any{"eid": eid, "quote": dedup[eid]})
	}

	cypher := `
MERGE (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})
ON CREATE SET d.created_at = timestamp()
SET d.updated_at = timestamp()
SET d.title = CASE WHEN $title <> '' THEN $title ELSE coalesce(d.title, '') END,
    d.content_hash = CASE WHEN $content_hash <> '' THEN $content_hash ELSE coalesce(d.content_hash, '') END
WITH d
OPTIONAL MATCH (d)<-[old:APPEARS_IN]-(:Entity)
DELETE old
WITH DISTINCT d
UNWIND $rows AS row
MATCH (e:Entity {eid: row.eid})
MERGE (e)-[ev:APPEARS_IN]->(d)
ON CREATE SET ev.created_at = timestamp()
SET ev.quote = row.quote, ev.updated_at = timestamp()
RETURN count(ev) AS linked`
	res, err := r.run(ctx, cypher, map[string]any{
		"uid": uid, "upload_uuid": uploadUUID, "title": title,
		"content_hash": contentHash, "rows": rows,
	})
	if err != nil {
		return 0, err
	}
	if len(res) == 0 {
		return 0, nil
	}
	return asInt64(res[0]["linked"]), nil
}

// DeleteCloudDocAppearances removes every knowledge evidence edge of one
// document and recycles Entity nodes left with no relationship at all (the
// CloudDoc node itself belongs to the routing graph and is not deleted here).
func (r *GraphRepo) DeleteCloudDocAppearances(ctx context.Context, uid int64, uploadUUID string) (deleted, entitiesRemoved int64, err error) {
	cypher := `
MATCH (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})<-[ev:APPEARS_IN]-(:Entity)
DELETE ev
RETURN count(ev) AS deleted`
	res, err := r.run(ctx, cypher, map[string]any{"uid": uid, "upload_uuid": uploadUUID})
	if err != nil {
		return 0, 0, err
	}
	if len(res) > 0 {
		deleted = asInt64(res[0]["deleted"])
	}
	entitiesRemoved, err = r.recycleOrphanEntities(ctx)
	if err != nil {
		return deleted, 0, err
	}
	if deleted != 0 || entitiesRemoved != 0 {
		slog.Info("[KG_REPO] delete_cloud_doc_evidence", "uid", uid,
			"upload_uuid", uploadUUID, "deleted", deleted, "entities_removed", entitiesRemoved)
	}
	return deleted, entitiesRemoved, nil
}

// FetchCloudDocEvidence pulls the evidence rows of the given entities from the
// user's cloud documents. uid is mandatory (multi-tenant isolation);
// uploadUUIDs empty = all of the user's documents, otherwise scoped to that
// set. Rows carry the document title for citation rendering.
func (r *GraphRepo) FetchCloudDocEvidence(ctx context.Context, eids []string, uid int64, uploadUUIDs []string, limit int32) ([]CloudDocEvidence, error) {
	if len(eids) == 0 {
		return nil, nil
	}
	if uploadUUIDs == nil {
		uploadUUIDs = []string{}
	}
	cypher := `
UNWIND $eids AS eid
MATCH (e:Entity {eid: eid})-[ev:APPEARS_IN]->(d:CloudDoc)
WHERE d.uid = $uid AND (size($upload_uuids) = 0 OR d.upload_uuid IN $upload_uuids)
RETURN e.eid AS eid, e.name AS name, e.type AS type,
       d.upload_uuid AS upload_uuid, coalesce(d.title, '') AS title, ev.quote AS quote
LIMIT $limit`
	rows, err := r.run(ctx, cypher, map[string]any{
		"eids": eids, "uid": uid, "upload_uuids": uploadUUIDs, "limit": limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]CloudDocEvidence, 0, len(rows))
	for _, row := range rows {
		out = append(out, CloudDocEvidence{
			Eid:        asString(row["eid"]),
			Name:       asString(row["name"]),
			Type:       asString(row["type"]),
			UploadUUID: asString(row["upload_uuid"]),
			Title:      asString(row["title"]),
			Quote:      asString(row["quote"]),
		})
	}
	return out, nil
}

// recycleOrphanEntities removes Entity nodes with no relationship at all
// (neither RELATES nor any APPEARS_IN target). Shared cleanup for cloud-doc
// evidence deletion and cloud-doc graph deletion; video entities survive while
// they still have an edge.
func (r *GraphRepo) recycleOrphanEntities(ctx context.Context) (int64, error) {
	res, err := r.run(ctx,
		"MATCH (e:Entity) WHERE NOT (e)--() DELETE e RETURN count(e) AS removed", nil)
	if err != nil {
		return 0, fmt.Errorf("recycle orphan entities: %w", err)
	}
	if len(res) == 0 {
		return 0, nil
	}
	return asInt64(res[0]["removed"]), nil
}
