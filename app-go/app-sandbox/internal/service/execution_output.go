package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

const (
	defaultOutputLimit = 32 * 1024
	maxOutputLimit     = 128 * 1024
)

// ExecutionOutput is one paged slice of a terminal execution's captured stream.
type ExecutionOutput struct {
	ExecutionID string `json:"executionId"`
	Stream      string `json:"stream"`
	Content     string `json:"content"`
	Offset      int64  `json:"offset"`
	Bytes       int64  `json:"bytes"`
	TotalBytes  int64  `json:"totalBytes"`
	SourceBytes int64  `json:"sourceBytes"`
	Truncated   bool   `json:"truncated"`
	HasMore     bool   `json:"hasMore"`
	NextOffset  int64  `json:"nextOffset"`
}

// Output serves paged stdout/stderr for one terminal execution. The full stream
// is bounded at capture time (1 MiB); sourceBytes reports what the program
// actually wrote, and truncated=true means the capture cap was hit.
func (s *ExecutionService) Output(ctx context.Context, uid int64, executionID, stream string, offset, limit int64) (*ExecutionOutput, error) {
	exec, err := s.executions.GetExecution(ctx, executionID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			return nil, fmt.Errorf("%w: execution %q not found", ErrNotFound, executionID)
		}
		return nil, err
	}
	if exec.UID != uid {
		// Never leak another tenant's execution ids.
		return nil, fmt.Errorf("%w: execution %q not found", ErrNotFound, executionID)
	}
	if !model.IsExecTerminal(exec.Status) {
		return nil, fmt.Errorf("%w: execution is not finished", ErrValidation)
	}
	stream = strings.ToLower(strings.TrimSpace(stream))
	if stream == "" {
		stream = "stdout"
	}
	var full string
	var sourceBytes int64
	switch stream {
	case "stdout":
		full, sourceBytes = exec.StdoutFull, exec.StdoutBytes
		if full == "" {
			full = exec.StdoutPreview
		}
	case "stderr":
		full, sourceBytes = exec.StderrFull, exec.StderrBytes
		if full == "" {
			full = exec.StderrPreview
		}
	default:
		return nil, fmt.Errorf("%w: stream must be stdout or stderr", ErrValidation)
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = defaultOutputLimit
	}
	if limit > maxOutputLimit {
		limit = maxOutputLimit
	}
	data := []byte(full)
	content, actualOffset, nextOffset, hasMore := SliceFileContent(data, offset, limit)
	return &ExecutionOutput{
		ExecutionID: executionID,
		Stream:      stream,
		Content:     content,
		Offset:      actualOffset,
		Bytes:       int64(len(content)),
		TotalBytes:  int64(len(data)),
		SourceBytes: sourceBytes,
		Truncated:   sourceBytes > int64(len(data)),
		HasMore:     hasMore,
		NextOffset:  nextOffset,
	}, nil
}
