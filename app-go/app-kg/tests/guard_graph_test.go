// Package tests holds every Go test of app-kg in ONE place: structural guards
// (Cypher/SQL contracts, layering) plus service/transport/config behaviour.
// Tests live in a separate package (not mixed into the tested packages) so the
// public surface is the only thing under test — matching app-cloud/tests.
package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	neo4jrepo "app-kg/internal/repo/neo4j"
)

const repoNeo4jDir = "../internal/repo/neo4j"

// readRepoSource loads one repository source file for structural assertions
// (no external deps needed).
func readRepoSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoNeo4jDir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// Guard: every Cypher statement issued by the graph repository must MERGE on
// the canonical keys (name_lower for Entity, bvid for Video) and never
// normalize names itself — normalization (name_lower/eid) is the CALLER's job
// and the single implementation lives in app-ts's resolver. Pins the
// dual-write contract with the retired Python KgGraphRepository.
func TestMergeKeysAndNoNormalization(t *testing.T) {
	src := readRepoSource(t, "graph.go")
	checks := []struct {
		name    string
		must    []string
		mustNot []string
	}{
		{
			name: "UpsertEntities",
			must: []string{"MERGE (e:Entity {name_lower: row.name_lower})", "ON CREATE SET e.eid = row.eid"},
			mustNot: []string{
				// sha1/normalization must never happen in Cypher or Go code here
				"sha1", "toLower(row.name_lower)",
			},
		},
		{
			name: "LinkAppearances",
			must: []string{"MERGE (v:Video {bvid: $bvid})", "MERGE (e)-[ev:APPEARS_IN {page_index: $page_index}]->(v)"},
		},
		{
			name: "UpsertRelations",
			must: []string{"MERGE (a)-[r:RELATES {rel_type: row.rel_type}]->(b)"},
		},
	}
	for _, c := range checks {
		segment := segmentFor(t, src, c.name)
		for _, m := range c.must {
			if !strings.Contains(segment, m) {
				t.Errorf("%s: Cypher missing canonical fragment %q", c.name, m)
			}
		}
		for _, banned := range c.mustNot {
			if strings.Contains(strings.ToLower(segment), strings.ToLower(banned)) {
				t.Errorf("%s: Cypher contains banned fragment %q (normalization belongs to the caller)", c.name, banned)
			}
		}
	}
}

// Guard: the relation quote sliding window must stay at 3 (parity with the
// Python MAX_RELATION_QUOTES).
func TestMaxRelationQuotes(t *testing.T) {
	if neo4jrepo.MaxRelationQuotes != 3 {
		t.Fatalf("MaxRelationQuotes = %d, want 3 (parity with Python)", neo4jrepo.MaxRelationQuotes)
	}
}

func segmentFor(t *testing.T, src string, fn string) string {
	t.Helper()
	idx := strings.Index(src, "func (r *GraphRepo) "+fn+"(")
	if idx < 0 {
		t.Fatalf("method %s not found", fn)
	}
	rest := src[idx:]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		end = len(rest)
	}
	return rest[:end]
}

// Guard: every cloud-doc routing Cypher statement must scope on uid —
// multi-tenant isolation is enforced in Cypher, never by the caller. Also: the
// graph never normalizes names (name_lower arrives precomputed from the caller).
func TestCloudDocGraphUIDScoping(t *testing.T) {
	for _, frag := range []string{
		"{uid: $uid, upload_uuid: $upload_uuid}",
		"(t:CloudTopic {uid: $uid, name_lower: row.name_lower})",
		"(en:CloudEntity {uid: $uid, name_lower: row.name_lower})",
		"(t:CloudTopic {uid: $uid})",
		"(en:CloudEntity {uid: $uid})",
	} {
		if !strings.Contains(frag, "$uid") {
			t.Fatalf("fragment missing uid scope: %s", frag)
		}
	}
	src := readRepoSource(t, "cloud.go")
	for _, banned := range []string{"sha1(", "toLower(row.name_lower)"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud graph Cypher contains banned normalization fragment %q", banned)
		}
	}
}

// Guard: label separation — cloud routing operations must not touch the video
// KG labels (Entity/Video) and vice versa; ClearAll semantics stay intact.
func TestCloudDocGraphLabelSeparation(t *testing.T) {
	src := readRepoSource(t, "cloud.go")
	for _, banned := range []string{":Entity ", ":Video ", "APPEARS_IN", "RELATES"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud graph must not touch video-KG labels/edge types: %q found", banned)
		}
	}
}

// Guard: cloud-doc knowledge evidence must stay multi-tenant (uid on the
// CloudDoc node and in every query) and must never normalize names itself.
func TestCloudDocKnowledgeUIDScoping(t *testing.T) {
	src := readRepoSource(t, "cloud_kg.go")
	for _, frag := range []string{
		"MERGE (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})",
		"MATCH (d:CloudDoc {uid: $uid, upload_uuid: $upload_uuid})<-[ev:APPEARS_IN]-(:Entity)",
		"WHERE d.uid = $uid",
	} {
		if !strings.Contains(src, frag) {
			t.Errorf("cloud knowledge Cypher missing uid-scoped fragment %q", frag)
		}
	}
	for _, banned := range []string{"sha1", "toLower(row.name_lower)"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud knowledge Cypher contains banned normalization fragment %q", banned)
		}
	}
}

// Guard: link is delete-before-write — a document's old evidence must be
// dropped before the new edges are written (a recomputed extraction must not
// leave stale relationships behind).
func TestCloudDocKnowledgeDeleteBeforeWrite(t *testing.T) {
	src := readRepoSource(t, "cloud_kg.go")
	del := strings.Index(src, "DELETE old")
	write := strings.Index(src, "MERGE (e)-[ev:APPEARS_IN]->(d)")
	if del < 0 || write < 0 {
		t.Fatalf("delete-before-write fragments not found (delete=%d write=%d)", del, write)
	}
	if del > write {
		t.Fatalf("old evidence must be deleted before the new edges are written")
	}
	if !strings.Contains(src, "WITH DISTINCT d") {
		t.Error("rows must be collapsed after deleting old evidence (one row per doc, not one per deleted edge)")
	}
}

// Guard: cloud-doc knowledge operations never touch the video label, and the
// duplicate-quote rule matches the video KG (shortest non-empty quote wins,
// dedupe by eid).
func TestCloudDocKnowledgeLabelAndDedup(t *testing.T) {
	src := readRepoSource(t, "cloud_kg.go")
	for _, banned := range []string{":Video ", "page_index"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud knowledge must not touch video-KG specifics: %q found", banned)
		}
	}
	if !strings.Contains(src, "if a.Quote != \"\" && (cur == \"\" || len(a.Quote) < len(cur))") {
		t.Error("shortest-quote dedup rule missing (parity with LinkAppearances)")
	}
	if !strings.Contains(src, "MATCH (e:Entity) WHERE NOT (e)--() DELETE e") {
		t.Error("orphan Entity recycling missing from cloud-doc evidence deletion")
	}
}

// Guard: knowledge evidence must not be counted as video evidence — Stats
// treats the two sources separately.
func TestStatsSplitsVideoAndCloudEvidence(t *testing.T) {
	src := readRepoSource(t, "graph.go")
	if !strings.Contains(src, "MATCH (:Entity)-[a:APPEARS_IN]->(:Video) RETURN count(a) as evidence") {
		t.Error("video evidence counter must be scoped to :Video")
	}
	for _, frag := range []string{
		"count(DISTINCT d) AS cloud_docs",
		"count(a) AS cloud_evidence",
	} {
		if !strings.Contains(src, frag) {
			t.Errorf("graph stats missing cloud counter fragment %q", frag)
		}
	}
}
