package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

const (
	defaultFileReadLimit = 32 * 1024
	maxFileReadLimit     = 128 * 1024
	maxFileReadBytes     = 32 << 20
	maxFileWriteBytes    = 8 << 20
)

// FileReadResult is one offset-addressed slice of a sandbox text file.
type FileReadResult struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	Offset     int64  `json:"offset"`
	Bytes      int64  `json:"bytes"`
	TotalBytes int64  `json:"totalBytes"`
	HasMore    bool   `json:"hasMore"`
	NextOffset int64  `json:"nextOffset"`
}

// FileWriteResult acknowledges one text file write.
type FileWriteResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

// FileService reads/writes text files in the caller's reusable sandbox. The API
// is offset-addressed so an agent can page through outputs larger than the
// per-call limit instead of losing everything after a truncation.
type FileService struct {
	leases *LeaseManager
	rt     runtime.Runtime
}

// NewFileService wires the file tool service.
func NewFileService(leases *LeaseManager, rt runtime.Runtime) *FileService {
	return &FileService{leases: leases, rt: rt}
}

// Read returns the byte slice [offset, offset+limit) of path. Offsets are UTF-8
// byte offsets and are always rounded to a rune boundary.
func (s *FileService) Read(ctx context.Context, uid int64, projectID, purpose, rawPath string, offset, limit int64) (*FileReadResult, error) {
	clean, err := sanitizeFileToolPath(rawPath)
	if err != nil {
		return nil, err
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = defaultFileReadLimit
	}
	if limit > maxFileReadLimit {
		limit = maxFileReadLimit
	}
	sandboxID, err := s.sandboxID(ctx, uid, projectID, purpose)
	if err != nil {
		return nil, err
	}
	data, err := s.rt.DownloadFile(ctx, sandboxID, clean, maxFileReadBytes)
	if err != nil {
		if errors.Is(err, runtime.ErrNotFound) {
			return nil, fmt.Errorf("%w: file %q does not exist", ErrNotFound, clean)
		}
		return nil, fmt.Errorf("read file: %w", err)
	}
	content, actualOffset, nextOffset, hasMore := SliceFileContent(data, offset, limit)
	return &FileReadResult{
		Path:       clean,
		Content:    content,
		Offset:     actualOffset,
		Bytes:      int64(len(content)),
		TotalBytes: int64(len(data)),
		HasMore:    hasMore,
		NextOffset: nextOffset,
	}, nil
}

// Write replaces one text file in the caller's reusable sandbox.
func (s *FileService) Write(ctx context.Context, uid int64, projectID, purpose, rawPath, content, encoding string) (*FileWriteResult, error) {
	clean, err := sanitizeFileToolPath(rawPath)
	if err != nil {
		return nil, err
	}
	if encoding == "base64" {
		decoded, derr := base64.StdEncoding.DecodeString(content)
		if derr != nil {
			return nil, errValidation("file content is not valid base64")
		}
		content = string(decoded)
	} else if encoding != "" && encoding != "utf8" {
		return nil, errValidation("file encoding must be utf8 or base64")
	}
	if len(content) > maxFileWriteBytes {
		return nil, errValidation("file content exceeds %d bytes", maxFileWriteBytes)
	}
	sandboxID, err := s.sandboxID(ctx, uid, projectID, purpose)
	if err != nil {
		return nil, err
	}
	// Create parent directories through the same sandbox shell so nested output
	// paths work without asking the caller to mkdir first.
	if dir := path.Dir(clean); dir != "" && dir != "/" {
		cmd := "mkdir -p " + shellQuotePath(dir)
		if _, err := s.rt.Exec(ctx, runtime.ExecRequest{
			SandboxID: sandboxID,
			Language:  "sh",
			Code:      cmd,
			Timeout:   5 * time.Second,
		}); err != nil {
			return nil, fmt.Errorf("prepare file directory: %w", err)
		}
	}
	if err := s.rt.WriteFile(ctx, sandboxID, runtime.File{Path: clean, Content: content}); err != nil {
		return nil, fmt.Errorf("write file: %w", err)
	}
	return &FileWriteResult{Path: clean, Bytes: int64(len(content))}, nil
}

func (s *FileService) sandboxID(ctx context.Context, uid int64, projectID, purpose string) (string, error) {
	sandboxID, err := s.leases.ResolveSandbox(ctx, uid, projectID, purpose)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			return "", fmt.Errorf("%w: no reusable sandbox workspace for this scope", ErrNotFound)
		}
		return "", fmt.Errorf("resolve sandbox: %w", err)
	}
	return sandboxID, nil
}

// SliceFileContent returns [offset, nextOffset) adjusted to UTF-8 boundaries and
// whether more bytes remain. It is exported for tests.
func SliceFileContent(data []byte, offset, limit int64) (string, int64, int64, bool) {
	if offset < 0 {
		offset = 0
	}
	start := int(offset)
	if start > len(data) {
		start = len(data)
	}
	for start < len(data) && !utf8.RuneStart(data[start]) {
		start++
	}
	end := start + int(limit)
	if end > len(data) {
		end = len(data)
	}
	for end > start && end < len(data) && !utf8.RuneStart(data[end]) {
		end--
	}
	hasMore := end < len(data)
	return string(data[start:end]), int64(start), int64(end), hasMore
}

func sanitizeFileToolPath(raw string) (string, error) {
	clean, err := sanitizeSandboxPath(raw)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(clean, "/workspace/") {
		return "", errValidation("file tool path must live under /workspace")
	}
	return clean, nil
}
