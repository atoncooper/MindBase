package graph

import (
	"os"
	"strings"
	"testing"
)

// readSource loads graph.go for structural assertions (no external deps).
func readSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("graph.go")
	if err != nil {
		t.Fatalf("read graph.go: %v", err)
	}
	return string(b)
}

var _ = strings.Contains
