package tests

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Guard: structure-only test — parse the import graph of the service and fail
// on layer violations. The layering contract is
//
//	main → transport/{grpc,http} → service → repo → infra
//
// config only loads settings (and embeds the infra config shapes); it is the
// single place that reads YAML/env.
const modulePrefix = "app-kg/internal/"

type layer struct {
	dir       string
	forbidden []string
}

func TestLayerBoundaries(t *testing.T) {
	dirs := []string{
		"../internal/config",
		"../internal/infra/mysql",
		"../internal/infra/neo4j",
		"../internal/repo/mysql",
		"../internal/repo/neo4j",
		"../internal/service",
		"../internal/transport/grpc",
		"../internal/transport/http",
	}
	for _, dir := range dirs {
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			t.Fatalf("expected layer package directory %s to exist (got %v)", dir, err)
		}
	}

	layers := []layer{
		// infra: database initialization only — never data access or business.
		{dir: "../internal/infra/mysql", forbidden: []string{"repo/", "service/", "transport/", "config"}},
		{dir: "../internal/infra/neo4j", forbidden: []string{"repo/", "service/", "transport/", "config"}},
		// repo: SQL/Cypher only — may use infra handles, never business/protocol.
		{dir: "../internal/repo/mysql", forbidden: []string{"service/", "transport/", "config"}},
		{dir: "../internal/repo/neo4j", forbidden: []string{"service/", "transport/", "config"}},
		// service: business rules only — never a driver, connection, proto or HTTP.
		{dir: "../internal/service", forbidden: []string{"infra/", "transport/", "config", "kgpb"}},
		// transport: protocol mapping only — never SQL/Cypher or connections.
		{dir: "../internal/transport/grpc", forbidden: []string{"infra/", "repo/", "config"}},
		{dir: "../internal/transport/http", forbidden: []string{"infra/", "repo/", "config"}},
		// config: loads settings, embeds infra config shapes; no business.
		{dir: "../internal/config", forbidden: []string{"repo/", "service/", "transport/", "kgpb"}},
	}

	for _, l := range layers {
		for _, imp := range internalImports(t, l.dir) {
			rest := strings.TrimPrefix(imp, modulePrefix)
			for _, forbidden := range l.forbidden {
				if rest == forbidden || strings.HasPrefix(rest, forbidden) {
					t.Errorf("%s must not import %s (layer violation)", l.dir, imp)
				}
			}
		}
	}
}

// internalImports lists the app-kg/internal/... imports of the non-test Go
// files in dir.
func internalImports(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	seen := map[string]bool{}
	var out []string
	fset := token.NewFileSet()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") ||
			strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, entry.Name()), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s/%s: %v", dir, entry.Name(), err)
		}
		for _, spec := range file.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			if strings.HasPrefix(path, modulePrefix) && !seen[path] {
				seen[path] = true
				out = append(out, path)
			}
		}
	}
	return out
}
