// Package tests — layering guards for the merged service.
//
// The contract enforced here mirrors the Java-style layering the service
// follows: router = thin controller (DTO binding + service call + HTTP
// rendering), service = business rules, repo = SQL/data access. A controller
// must never reach into the data-access layer or issue SQL itself; business
// code must never depend on HTTP primitives or request DTOs.
package tests

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// sqlStatement detects literal SQL statements (not identifiers such as
// "select" used as a field name).
var sqlStatement = regexp.MustCompile("(?i)\\b(select\\s+[^\\n;]{0,120}\\s+from|insert\\s+into|update\\s+[a-z_][a-z0-9_]*\\s+set|delete\\s+from)\\b")

type layerRule struct {
	dir       string
	forbidden []string
	noSQL     bool
}

// TestLayerBoundaries enforces the import direction router -> service -> repo:
//   - internal/router/**  (controllers) may not import repo/model/infra or a DB
//     driver, and may not contain SQL statements.
//   - internal/service/** (business) may not import HTTP/gin, middleware, DTOs
//     or routers, and may not contain SQL statements (SQL lives in repo).
//   - internal/repo/**    (data access) may not import service/router/middleware/
//     DTOs or HTTP, so it stays a pure storage layer.
func TestLayerBoundaries(t *testing.T) {
	root := moduleRoot(t)
	rules := []layerRule{
		{
			dir: "internal/router",
			forbidden: []string{
				"app-content/internal/repo/",
				"app-content/internal/model/",
				"app-content/internal/infra/",
				"gorm.io/",
				"database/sql",
			},
			noSQL: true,
		},
		{
			dir: "internal/service",
			forbidden: []string{
				"app-content/internal/router/",
				"app-content/internal/middleware/",
				"app-content/internal/dto/",
				"github.com/gin-gonic/gin",
			},
			noSQL: true,
		},
		{
			// DTOs are the transport contract: they must not depend on service
			// or repo types, otherwise the wire schema silently follows domain
			// internals (controller/service map into DTOs, never the reverse).
			dir: "internal/dto",
			forbidden: []string{
				"app-content/internal/service/",
				"app-content/internal/repo/",
				"app-content/internal/model/",
			},
		},
		{
			dir: "internal/repo",
			forbidden: []string{
				"app-content/internal/router/",
				"app-content/internal/service/",
				"app-content/internal/middleware/",
				"app-content/internal/dto/",
				"github.com/gin-gonic/gin",
				"net/http",
			},
		},
	}

	for _, rule := range rules {
		rule := rule
		base := filepath.Join(root, filepath.FromSlash(rule.dir))
		err := filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			name := d.Name()
			if d.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				return nil
			}
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			rel = filepath.ToSlash(rel)

			fset := token.NewFileSet()
			file, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if parseErr != nil {
				return parseErr
			}
			for _, imp := range file.Imports {
				importPath, unquoteErr := strconv.Unquote(imp.Path.Value)
				if unquoteErr != nil {
					return unquoteErr
				}
				for _, bad := range rule.forbidden {
					if strings.HasPrefix(importPath, bad) || importPath == strings.TrimSuffix(bad, "/") {
						t.Errorf("%s imports %q: %s layer may not depend on %s", rel, importPath, rule.dir, bad)
					}
				}
			}

			if rule.noSQL {
				raw, readErr := os.ReadFile(path)
				if readErr != nil {
					return readErr
				}
				if m := sqlStatement.FindString(string(raw)); m != "" {
					t.Errorf("%s contains SQL (%q): SQL statements must live in internal/repo", rel, m)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", rule.dir, err)
		}
	}
}
