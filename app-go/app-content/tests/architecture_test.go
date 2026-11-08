// Package tests holds module-level guard tests (architecture + config).
package tests

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var domains = map[string]bool{"board": true, "note": true, "quiz": true}

// domainOfExtracts returns ("layer", "domain") for cross-domain-checkable
// package paths: internal/{model,repo,router,bootstrap}/<domain> and
// internal/infra/<kind>/<domain>.
func splitDomainPath(importPath string) (layer, domain string, ok bool) {
	trimmed := strings.TrimPrefix(importPath, "app-content/internal/")
	parts := strings.Split(trimmed, "/")
	if len(parts) < 2 {
		return "", "", false
	}
	if domains[parts[1]] {
		return parts[0], parts[1], true
	}
	if parts[0] == "infra" && len(parts) >= 3 && domains[parts[2]] {
		return "infra/" + parts[1], parts[2], true
	}
	return "", "", false
}

// TestOnlyOneMainPackage asserts the merged service exposes exactly one
// executable entry point: internal/bootstrap holds in-process composition,
// not separately runnable apps.
func TestOnlyOneMainPackage(t *testing.T) {
	root := moduleRoot(t)
	var mains []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, perr := parser.ParseFile(token.NewFileSet(), path, nil, parser.PackageClauseOnly)
		if perr != nil {
			return perr
		}
		if f.Name.Name == "main" {
			mains = append(mains, filepath.ToSlash(strings.TrimPrefix(path, root+string(filepath.Separator))))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	if len(mains) != 1 || mains[0] != "cmd/app-content/main.go" {
		t.Fatalf("main packages = %v, want exactly [cmd/app-content/main.go]", mains)
	}
}

// TestNoCrossDomainLayering forbids one domain from reaching into another
// domain's model/repo/router/infra packages. Cross-domain needs must go
// through the target domain's service interface (or a neutral package), so a
// single-process deployment stays layered instead of turning into a ball of
// mud.
func TestNoCrossDomainLayering(t *testing.T) {
	root := moduleRoot(t)
	var violations []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		// Which domain owns this file? internal/<layer>/<domain>/... or
		// internal/infra/<kind>/<domain>/...
		parts := strings.Split(rel, "/")
		owner := ""
		if len(parts) >= 3 && parts[0] == "internal" {
			if parts[1] == "infra" {
				// internal/infra/<kind>/<domain>/...
				if len(parts) >= 4 && domains[parts[3]] {
					owner = parts[3]
				}
			} else if parts[2] != "" && domains[parts[2]] && parts[1] != "service" && parts[1] != "config" {
				owner = parts[2]
			}
		}
		if owner == "" {
			return nil
		}
		f, perr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if perr != nil {
			return perr
		}
		for _, imp := range f.Imports {
			p, uerr := strconv.Unquote(imp.Path.Value)
			if uerr != nil {
				continue
			}
			_, depDomain, ok := splitDomainPath(p)
			if ok && depDomain != owner {
				violations = append(violations, rel+" imports "+p)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	if len(violations) > 0 {
		t.Fatalf("cross-domain layer imports found (route through services): %s", strings.Join(violations, "; "))
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Dir(wd)
}

// TestSingleListener guards the "one process, one port" contract: the module
// must contain exactly one *http.Server construction and one ListenAndServe*
// call, both in the composition root (internal/bootstrap/server.go).
func TestSingleListener(t *testing.T) {
	root := moduleRoot(t)
	var servers, listens []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body := string(raw)
		if strings.Contains(body, "http.Server{") {
			servers = append(servers, filepath.ToSlash(rel))
		}
		if strings.Contains(body, "ListenAndServe()") || strings.Contains(body, "ListenAndServeTLS(") {
			listens = append(listens, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	if len(servers) != 1 || servers[0] != "internal/bootstrap/server.go" {
		t.Fatalf("http.Server constructions = %v, want exactly [internal/bootstrap/server.go]", servers)
	}
	if len(listens) != 1 || listens[0] != "internal/bootstrap/server.go" {
		t.Fatalf("ListenAndServe calls = %v, want exactly [internal/bootstrap/server.go]", listens)
	}
}

// TestSingleDataStoreClients guards the "one process, one connection set"
// contract introduced by the content merge: exactly one MySQL pool, one
// MongoDB client and one Redis client — all owned by internal/infra.
func TestSingleDataStoreClients(t *testing.T) {
	root := moduleRoot(t)
	markers := map[string]string{
		"gorm.Open(":             "internal/infra/mysql/mysql.go",
		"mongodriver.Connect(":   "internal/infra/mongo/mongo.go",
		"redisclient.NewClient(": "internal/infra/redis/redis.go",
	}
	found := map[string][]string{}
	var packageDB []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body := string(raw)
		for marker := range markers {
			if strings.Contains(body, marker) {
				found[marker] = append(found[marker], rel)
			}
		}
		if strings.Contains(body, "var DB *gorm.DB") || strings.Contains(body, "var DB *mongo.Database") {
			packageDB = append(packageDB, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	for marker, want := range markers {
		got := found[marker]
		if len(got) != 1 || got[0] != want {
			t.Errorf("%s found in %v, want exactly [%s]", marker, got, want)
		}
	}
	if len(packageDB) > 0 {
		t.Errorf("package-level DB globals found in %v; inject the shared handle instead", packageDB)
	}
}

// TestSingleGinEngine guards the "one Gin instance" contract: the composition
// root creates the only engine (gin.New) and every domain registers its routes
// on it. Domain routers must not create engines, and no ServeMux may take over
// request routing.
func TestSingleGinEngine(t *testing.T) {
	root := moduleRoot(t)
	var engines, muxes []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body := string(raw)
		if strings.Contains(body, "gin.New()") {
			engines = append(engines, filepath.ToSlash(rel))
		}
		if strings.Contains(body, "http.NewServeMux(") {
			muxes = append(muxes, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk module: %v", err)
	}
	if len(engines) != 1 || engines[0] != "internal/bootstrap/server.go" {
		t.Fatalf("gin.New() calls = %v, want exactly [internal/bootstrap/server.go]", engines)
	}
	if len(muxes) != 0 {
		t.Fatalf("http.NewServeMux() found in %v; routing must stay on the single Gin engine", muxes)
	}
}
