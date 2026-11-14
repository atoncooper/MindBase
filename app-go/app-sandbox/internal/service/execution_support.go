package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"

	"github.com/google/uuid"
)

// validateInputs normalizes file paths and restricts artifact globs to the
// configured output roots. Rejects escaping paths, oversized inputs and globs
// that could collect arbitrary sandbox files.
func (s *ExecutionService) validateInputs(req *CreateRequest) error {
	if strings.TrimSpace(req.ProjectID) != "" && len(req.ProjectID) > 64 {
		return errValidation("projectId exceeds 64 characters")
	}
	if strings.TrimSpace(req.Purpose) != "" && len(req.Purpose) > 32 {
		return errValidation("purpose exceeds 32 characters")
	}
	if len(req.Files) > 20 {
		return errValidation("at most 20 input files are allowed")
	}
	for i := range req.Files {
		clean, err := sanitizeSandboxPath(req.Files[i].Path)
		if err != nil {
			return err
		}
		req.Files[i].Path = clean
		if len(req.Files[i].Content) > 1<<20 {
			return errValidation("input file %q exceeds 1MB", clean)
		}
	}
	roots := s.artifactRoots()
	if len(req.ArtifactGlobs) > 10 {
		return errValidation("at most 10 artifact globs are allowed")
	}
	for _, pattern := range req.ArtifactGlobs {
		clean := path.Clean(strings.TrimSpace(pattern))
		if clean == "." || !strings.HasPrefix(clean, "/") || strings.Contains(clean, "..") {
			return errValidation("artifact glob %q must be an absolute path inside the output root", pattern)
		}
		allowed := false
		for _, root := range roots {
			if clean == root || strings.HasPrefix(clean, root+"/") {
				allowed = true
				break
			}
		}
		if !allowed {
			return errValidation("artifact glob %q is outside the allowed output root", pattern)
		}
	}
	return nil
}

// artifactRoots derives the allowed collection roots from the configured
// default globs (e.g. /workspace/analysis/outputs/** -> /workspace/analysis/outputs).
func (s *ExecutionService) artifactRoots() []string {
	roots := make([]string, 0, len(s.cfg.Artifacts.DefaultGlobs))
	for _, pattern := range s.cfg.Artifacts.DefaultGlobs {
		root := strings.TrimSpace(pattern)
		root = strings.TrimSuffix(root, "/**")
		root = strings.TrimSuffix(root, "/*")
		root = strings.TrimSuffix(root, "/")
		if root != "" {
			roots = append(roots, path.Clean(root))
		}
	}
	if len(roots) == 0 {
		roots = append(roots, "/workspace/analysis/outputs")
	}
	return roots
}

// sanitizeSandboxPath keeps in-sandbox writes inside /workspace or /tmp/osb-*.
func sanitizeSandboxPath(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsAny(trimmed, "\x00\n\r") {
		return "", errValidation("input file path is empty or contains control characters")
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/workspace/" + trimmed
	}
	clean := path.Clean(trimmed)
	if clean == "/" || strings.Contains(clean, "..") || !strings.HasPrefix(clean, "/") {
		return "", errValidation("input file path %q escapes the sandbox workspace", raw)
	}
	allowed := strings.HasPrefix(clean, "/workspace/") || strings.HasPrefix(clean, "/tmp/osb-")
	if !allowed {
		return "", errValidation("input file path %q must live under /workspace or /tmp/osb-*", raw)
	}
	return clean, nil
}

// ── helpers ──────────────────────────────────────────────────────────

func (s *ExecutionService) registerInflight(id string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inflight[id] = cancel
}

func (s *ExecutionService) unregisterInflight(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.inflight, id)
}

func (s *ExecutionService) cancelInflight(id string) {
	s.mu.Lock()
	cancel := s.inflight[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *ExecutionService) incrementUsage(ctx context.Context, uid int64, at time.Time, delta repo.UsageDelta) {
	if s.usage == nil {
		return
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.usage.IncrementUsage(bg, uid, s.day(at), delta); err != nil {
		slog.Warn("[EXEC] usage increment failed", "uid", uid, "err", err)
	}
}

func (s *ExecutionService) day(at time.Time) string {
	if s.quota != nil {
		return s.quota.Day(at)
	}
	return at.In(s.tz).Format("2006-01-02")
}

func (s *ExecutionService) auditExec(exec *model.SandboxExecution, req CreateRequest, actor, action, outcome, detail string, durationMS int64, exitCode *int) {
	if s.audit == nil {
		return
	}
	row := &model.SandboxAudit{
		ID:          uuid.NewString(),
		UID:         exec.UID,
		Action:      action,
		ExecutionID: exec.ID,
		LeaseID:     exec.LeaseID,
		ProjectID:   exec.ProjectID,
		Image:       s.cfg.Runtime.Image,
		Outcome:     outcome,
		DurationMS:  durationMS,
		ExitCode:    exitCode,
		Detail:      truncateText(detail, 512),
		RequestID:   req.RequestID,
		Actor:       actor,
		CreatedAt:   s.now(),
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 5*time.Second)
	defer cancel()
	if err := s.audit.InsertAudit(bg, row); err != nil {
		slog.Warn("[EXEC] audit insert failed", "execution", exec.ID, "err", err)
	}
}

func (s *ExecutionService) idempotent(ctx context.Context, uid int64, key string) (*model.SandboxExecution, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, false
	}
	now := s.now()
	idemKey := fmt.Sprintf("%d|%s", uid, key)
	s.mu.Lock()
	entry, ok := s.idem[idemKey]
	if ok && !now.Before(entry.expiresAt) {
		delete(s.idem, idemKey)
		ok = false
	}
	s.mu.Unlock()
	if !ok {
		return nil, false
	}
	exec, err := s.executions.GetExecution(ctx, entry.executionID)
	if err != nil {
		return nil, false
	}
	return exec, true
}

func (s *ExecutionService) rememberIdempotent(uid int64, key, executionID string) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	ttl := time.Duration(s.cfg.Execution.IdempotencyTTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	now := s.now()
	idemKey := fmt.Sprintf("%d|%s", uid, key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.idem) > 10000 {
		for k, v := range s.idem {
			if !now.Before(v.expiresAt) {
				delete(s.idem, k)
			}
		}
	}
	s.idem[idemKey] = idemEntry{executionID: executionID, expiresAt: now.Add(ttl)}
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// truncateText cuts a string to at most n bytes on a UTF-8 boundary.
func truncateText(text string, n int) string {
	if n <= 0 || len(text) <= n {
		return text
	}
	cut := n
	for cut > 0 && (text[cut]&0xC0) == 0x80 {
		cut--
	}
	return text[:cut]
}
