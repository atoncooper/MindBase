package service

import (
	"context"
	"time"

	"app-sandbox/internal/model"
)

// ── publishing ───────────────────────────────────────────────────────

func (s *ExecutionService) publishStatus(exec *model.SandboxExecution) {
	s.hub.Publish(exec.ID, Event{Type: "status", Data: executionEventData(exec)})
}

func (s *ExecutionService) publishStream(executionID, stdout, stderr string, preview int) {
	if stdout != "" {
		s.hub.Publish(executionID, Event{Type: "stdout", Data: map[string]any{
			"executionId": executionID,
			"preview":     truncateText(stdout, preview),
			"bytes":       len(stdout),
		}})
	}
	if stderr != "" {
		s.hub.Publish(executionID, Event{Type: "stderr", Data: map[string]any{
			"executionId": executionID,
			"preview":     truncateText(stderr, preview),
			"bytes":       len(stderr),
		}})
	}
}

func (s *ExecutionService) publishArtifacts(executionID string, rows []model.SandboxArtifact) {
	ttl := time.Duration(s.cfg.Artifacts.PresignTTLSeconds) * time.Second
	for _, row := range rows {
		url := ""
		if s.artifactStore != nil {
			presignCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			presigned, err := s.artifactStore.Presign(presignCtx, row.ObjectKey, ttl)
			cancel()
			if err == nil {
				url = presigned
			}
		}
		s.hub.Publish(executionID, Event{Type: "artifact", Data: map[string]any{
			"executionId": executionID,
			"name":        row.Name,
			"size":        row.SizeBytes,
			"sha256":      row.SHA256,
			"contentType": row.ContentType,
			"url":         url,
		}})
	}
}

func (s *ExecutionService) publishDone(executionID, status, errorCode string) {
	s.hub.Publish(executionID, Event{Type: "done", Data: map[string]any{
		"executionId": executionID,
		"status":      status,
		"errorCode":   errorCode,
	}})
	s.hub.Close(executionID)
}

func executionEventData(exec *model.SandboxExecution) map[string]any {
	data := map[string]any{
		"executionId": exec.ID,
		"status":      exec.Status,
		"leaseId":     exec.LeaseID,
		"language":    exec.Language,
		"timeoutMs":   exec.TimeoutMS,
		"errorCode":   exec.ErrorCode,
	}
	if exec.ExitCode != nil {
		data["exitCode"] = *exec.ExitCode
	}
	if exec.StartedAt != nil {
		data["startedAt"] = *exec.StartedAt
	}
	if exec.FinishedAt != nil {
		data["finishedAt"] = *exec.FinishedAt
	}
	return data
}
