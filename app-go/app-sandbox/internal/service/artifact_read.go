package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"unicode/utf8"

	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

// ArtifactReadResult is one paged read of a stored artifact.
type ArtifactReadResult struct {
	ExecutionID string `json:"executionId"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Encoding    string `json:"encoding"` // utf8 | base64
	Binary      bool   `json:"binary"`
	Content     string `json:"content"`
	Offset      int64  `json:"offset"`
	Bytes       int64  `json:"bytes"`
	TotalBytes  int64  `json:"totalBytes"`
	HasMore     bool   `json:"hasMore"`
	NextOffset  int64  `json:"nextOffset"`
}

// ReadArtifact pages through one artifact's object bytes. Text artifacts are
// returned as UTF-8; binary artifacts are base64 with binary=true.
func (s *ExecutionService) ReadArtifact(ctx context.Context, uid int64, executionID, name string, offset, limit int64) (*ArtifactReadResult, error) {
	exec, err := s.executions.GetExecution(ctx, executionID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			return nil, fmt.Errorf("%w: execution %q not found", ErrNotFound, executionID)
		}
		return nil, err
	}
	if exec.UID != uid {
		return nil, fmt.Errorf("%w: execution %q not found", ErrNotFound, executionID)
	}
	if !model.IsExecTerminal(exec.Status) {
		return nil, fmt.Errorf("%w: execution is not finished", ErrValidation)
	}
	rows, err := s.artifacts.ListArtifactsByExecution(ctx, executionID)
	if err != nil {
		return nil, err
	}
	var row *model.SandboxArtifact
	for i := range rows {
		if rows[i].Name == name {
			row = &rows[i]
			break
		}
	}
	if row == nil {
		return nil, fmt.Errorf("%w: artifact %q not found", ErrNotFound, name)
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
	data, err := s.artifactStore.Read(ctx, row.ObjectKey, maxFileReadBytes)
	if err != nil {
		return nil, fmt.Errorf("read artifact: %w", err)
	}
	result := &ArtifactReadResult{
		ExecutionID: executionID,
		Name:        row.Name,
		ContentType: row.ContentType,
		TotalBytes:  int64(len(data)),
	}
	if binaryData(data) {
		start := int(offset)
		if start > len(data) {
			start = len(data)
		}
		end := start + int(limit)
		if end > len(data) {
			end = len(data)
		}
		result.Encoding = "base64"
		result.Binary = true
		result.Offset = int64(start)
		result.Bytes = int64(end - start)
		result.Content = base64.StdEncoding.EncodeToString(data[start:end])
		result.HasMore = end < len(data)
		result.NextOffset = int64(end)
		return result, nil
	}
	content, actualOffset, nextOffset, hasMore := SliceFileContent(data, offset, limit)
	result.Encoding = "utf8"
	result.Content = content
	result.Offset = actualOffset
	result.Bytes = int64(len(content))
	result.HasMore = hasMore
	result.NextOffset = nextOffset
	return result, nil
}

func binaryData(data []byte) bool {
	return bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data)
}
