package tests

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDomainImportDirection pins the layered boundary:
//   - infra / config / logger / contracts must not import a domain
//   - auth / bili / settings must not import each other (cross-domain only via contracts)
func TestDomainImportDirection(t *testing.T) {
	root := moduleRoot(t)
	internal := filepath.Join(root, "internal")

	err := filepath.Walk(internal, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		rel, _ := filepath.Rel(internal, path)
		rel = filepath.ToSlash(rel)
		src := domainOfPath(rel)
		if isInfraPath(rel) || strings.HasPrefix(rel, "tests/") {
			src = ""
		}
		f, perr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if perr != nil {
			t.Fatalf("parse %s: %v", rel, perr)
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, "\"")
			const prefix = "app-user/internal/"
			if !strings.HasPrefix(p, prefix) {
				continue
			}
			rest := strings.TrimPrefix(p, prefix)
			if strings.HasPrefix(rest, "infra/") || rest == "config" || rest == "logger" || rest == "contracts" {
				continue
			}
			dst := domainOfPath(rest)
			if dst == "" {
				continue
			}
			if src == "" {
				t.Errorf("%s: infra/global package must not import domain %q", rel, dst)
				continue
			}
			if dst != src {
				t.Errorf("%s: domain %q must not import domain %q (use internal/contracts)", rel, src, dst)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// TestRouterLayerHasNoSQL pins the layering rule: the HTTP layer only parses
// input and calls services — SQL/DB access belongs to internal/repo, business
// logic to internal/service.
func TestRouterLayerHasNoSQL(t *testing.T) {
	root := moduleRoot(t)
	routerRoot := filepath.Join(root, "internal", "router")
	forbiddenImports := []string{"gorm.io/gorm", "app-user/internal/infra/db", "app-user/internal/repo"}
	sqlPatterns := []string{"db.DB", ".WithContext(", ".Exec(", ".Raw(", ".Where(", ".First(", ".Find(", ".Create(", ".Update(", ".Delete("}

	err := filepath.Walk(routerRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		f, perr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if perr != nil {
			t.Fatalf("parse %s: %v", rel, perr)
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, "\"")
			for _, bad := range forbiddenImports {
				if p == bad || strings.HasPrefix(p, bad+"/") {
					t.Errorf("%s: router must not import %q (SQL belongs to internal/repo; business logic to internal/service)", rel, p)
				}
			}
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		for i, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue
			}
			for _, pat := range sqlPatterns {
				if strings.Contains(line, pat) {
					t.Errorf("%s:%d: router must not execute SQL (%q) — move it to internal/repo", rel, i+1, pat)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}
func domainOfPath(p string) string {
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "auth", "bili", "settings":
			return seg
		}
	}
	return ""
}

func isInfraPath(rel string) bool {
	return strings.HasPrefix(rel, "infra/") ||
		strings.HasPrefix(rel, "config/") ||
		strings.HasPrefix(rel, "logger/") ||
		strings.HasPrefix(rel, "contracts/")
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Dir(wd)
}
