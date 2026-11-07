package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDataOwnership pins who may mention which table. The domains share one
// process now, so a stray query would silently cross the boundary that the
// old process split used to enforce.
func TestDataOwnership(t *testing.T) {
	root := moduleRoot(t)
	var cases = []struct {
		domain    string
		dirs      []string
		forbidden []string
	}{
		{
			domain:    "auth",
			dirs:      []string{"internal/model/auth", "internal/repo/auth", "internal/service/auth", "internal/router/auth"},
			forbidden: []string{"collection", "favorite_folders", "video_versions", "async_tasks", "asr_documents", "user_preferences"},
		},
		{
			domain:    "bili",
			dirs:      []string{"internal/model/bili", "internal/repo/bili", "internal/service/bili", "internal/router/bili", "internal/bili"},
			forbidden: []string{"user_oauth", "user_tokens", "user_profile", "user_device", "verification_codes", "login_attempts", "rbac_role", "rbac_user_role", "user_preferences"},
		},
		{
			domain:    "settings",
			dirs:      []string{"internal/repo/settings", "internal/router/settings"},
			forbidden: []string{"user_oauth", "user_tokens", "user_profile", "user_device", "verification_codes", "login_attempts", "rbac_role", "rbac_user_role", "collection", "favorite_folders", "video_versions", "async_tasks"},
		},
	}
	for _, tc := range cases {
		for _, dir := range tc.dirs {
			full := filepath.Join(root, dir)
			err := filepath.Walk(full, func(path string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
					return nil
				}
				raw, rerr := os.ReadFile(path)
				if rerr != nil {
					return rerr
				}
				for _, line := range strings.Split(string(raw), "\n") {
					trimmed := strings.TrimSpace(line)
					if strings.HasPrefix(trimmed, "//") {
						continue
					}
					for _, bad := range tc.forbidden {
						if strings.Contains(trimmed, bad) {
							rel, _ := filepath.Rel(root, path)
							t.Errorf("%s: domain %q must not reference %q (owned by another domain)", rel, tc.domain, bad)
						}
					}
				}
				return nil
			})
			if err != nil {
				t.Fatalf("walk %s: %v", dir, err)
			}
		}
	}
}
