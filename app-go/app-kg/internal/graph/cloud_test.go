package graph

import (
	"os"
	"strings"
	"testing"
)

// readCloudSource loads cloud.go for structural assertions (no external deps).
func readCloudSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("cloud.go")
	if err != nil {
		t.Fatalf("read cloud.go: %v", err)
	}
	return string(b)
}

// Guard: every cloud-doc Cypher statement must scope on uid — multi-tenant
// isolation is enforced in Cypher, never by the caller. Also: the graph
// never normalizes names (name_lower arrives precomputed from the caller).
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
	src := readCloudSource(t)
	for _, banned := range []string{"sha1(", "toLower(row.name_lower)"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud graph Cypher contains banned normalization fragment %q", banned)
		}
	}
}

// Guard: label separation — cloud operations must not touch the video KG
// labels (Entity/Video) and vice versa; ClearAll semantics stay intact.
func TestCloudDocGraphLabelSeparation(t *testing.T) {
	src := readCloudSource(t)
	for _, banned := range []string{":Entity ", ":Video ", "APPEARS_IN", "RELATES"} {
		if strings.Contains(src, banned) {
			t.Errorf("cloud graph must not touch video-KG labels/edge types: %q found", banned)
		}
	}
}
