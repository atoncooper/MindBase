package graph

import (
	"strings"
	"testing"
)

// Guard: every Cypher statement issued by this package must MERGE on the
// canonical keys (name_lower for Entity, bvid for Video) and never normalize
// names itself — normalization (name_lower/eid) is the CALLER's job and the
// single implementation lives in app-ts's resolver / Python's repository.
// This pins the transition-time dual-write contract with the Python
// KgGraphRepository.
func TestMergeKeysAndNoNormalization(t *testing.T) {
	src := readSource(t)
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
	if MaxRelationQuotes != 3 {
		t.Fatalf("MaxRelationQuotes = %d, want 3 (parity with Python)", MaxRelationQuotes)
	}
}

func segmentFor(t *testing.T, src string, fn string) string {
	t.Helper()
	idx := strings.Index(src, "func (g *Store) "+fn+"(")
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
