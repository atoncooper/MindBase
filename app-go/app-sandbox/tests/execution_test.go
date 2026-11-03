package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

func TestExecutionSucceedsAndPersistsAuditAndUsage(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	exec := env.mustCreate(t, CreateRequest{
		UID: 11, ProjectID: "p1", Purpose: "academic", Language: "python", Code: "print('hi')",
		RequestID: "req-1",
	})
	if exec.Status != model.ExecStatusQueued {
		t.Fatalf("initial status = %s, want queued", exec.Status)
	}
	terminal := env.waitTerminal(t, 11, exec.ID)
	if terminal.Status != model.ExecStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", terminal.Status, terminal.ErrorCode)
	}
	if terminal.ExitCode == nil || *terminal.ExitCode != 0 {
		t.Fatalf("exit code = %v, want 0", terminal.ExitCode)
	}
	if !strings.Contains(terminal.StdoutPreview, "hello from sandbox") {
		t.Fatalf("stdout preview = %q", terminal.StdoutPreview)
	}
	if terminal.StdoutBytes != int64(len("hello from sandbox\n")) {
		t.Fatalf("stdout bytes = %d", terminal.StdoutBytes)
	}
	if terminal.LeaseID == "" {
		t.Fatal("execution must record its lease id")
	}

	audits, err := env.store.ListAuditByExecution(context.Background(), exec.ID)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	actions := make(map[string]bool, len(audits))
	for _, a := range audits {
		actions[a.Action] = true
	}
	for _, want := range []string{model.AuditExecutionCreate, model.AuditExecutionStart, model.AuditExecutionFinish} {
		if !actions[want] {
			t.Fatalf("audit action %s missing (got %v)", want, actions)
		}
	}

	usage, err := env.quota.Usage(context.Background(), 11)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if usage.Executions != 1 {
		t.Fatalf("usage executions = %d, want 1", usage.Executions)
	}
}

func TestExecutionFailsOnNonZeroExit(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{Stdout: "oops", Stderr: "boom", ExitCode: 3}, nil)
	exec := env.mustCreate(t, CreateRequest{UID: 12, Language: "python", Code: "raise SystemExit(3)"})
	terminal := env.waitTerminal(t, 12, exec.ID)
	if terminal.Status != model.ExecStatusFailed {
		t.Fatalf("status = %s, want failed", terminal.Status)
	}
	if terminal.ExitCode == nil || *terminal.ExitCode != 3 {
		t.Fatalf("exit code = %v, want 3", terminal.ExitCode)
	}
	if terminal.ErrorCode != "nonzero_exit" {
		t.Fatalf("error code = %q, want nonzero_exit", terminal.ErrorCode)
	}
	if terminal.StderrPreview != "boom" {
		t.Fatalf("stderr preview = %q", terminal.StderrPreview)
	}
}

func TestExecutionTimesOut(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{ExecDelay: 2 * time.Second, Stdout: "never"}, nil)
	exec := env.mustCreate(t, CreateRequest{UID: 13, Language: "python", Code: "while True: pass", TimeoutMS: 20})
	terminal := env.waitTerminal(t, 13, exec.ID)
	if terminal.Status != model.ExecStatusTimeout {
		t.Fatalf("status = %s, want timeout", terminal.Status)
	}
	if terminal.ErrorCode != "execution_timeout" {
		t.Fatalf("error code = %q", terminal.ErrorCode)
	}
}

func TestExecutionCancelIsIdempotentAndUidScoped(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{ExecDelay: 2 * time.Second}, nil)
	exec := env.mustCreate(t, CreateRequest{UID: 14, Language: "python", Code: "print(1)", TimeoutMS: 10000})
	env.waitStatus(t, exec.ID, model.ExecStatusRunning)

	if err := env.executions.Cancel(context.Background(), 999, exec.ID, "r1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign cancel: want ErrForbidden, got %v", err)
	}
	if err := env.executions.Cancel(context.Background(), 14, exec.ID, "r1"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := env.executions.Cancel(context.Background(), 14, exec.ID, "r1"); err != nil {
		t.Fatalf("second cancel must be a no-op, got %v", err)
	}
	terminal := env.waitTerminal(t, 14, exec.ID)
	if terminal.Status != model.ExecStatusCanceled {
		t.Fatalf("status = %s, want canceled", terminal.Status)
	}
}

func TestExecutionGetIsUidScoped(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	exec := env.mustCreate(t, CreateRequest{UID: 15, Language: "python", Code: "print(1)"})
	env.waitTerminal(t, 15, exec.ID)

	view, err := env.executions.Get(context.Background(), 15, exec.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Execution.ID != exec.ID {
		t.Fatalf("view execution id = %s", view.Execution.ID)
	}
	if _, err := env.executions.Get(context.Background(), 16, exec.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign get: want ErrForbidden, got %v", err)
	}
	if _, err := env.executions.Get(context.Background(), 15, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown get: want ErrNotFound, got %v", err)
	}
}

func TestExecutionValidation(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	cases := []CreateRequest{
		{UID: 17, Language: "ruby", Code: "puts 1"},
		{UID: 17, Language: "python", Code: "   "},
	}
	for _, req := range cases {
		if _, err := env.executions.Create(context.Background(), req); !errors.Is(err, ErrValidation) {
			t.Fatalf("req %+v: want ErrValidation, got %v", req, err)
		}
	}
	// Code over the configured limit is rejected before any row is created.
	env.cfg.Execution.MaxCodeBytes = 8
	if _, err := env.executions.Create(context.Background(), CreateRequest{UID: 17, Language: "python", Code: "print('too long')"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("oversized code: want ErrValidation, got %v", err)
	}
}

func TestExecutionIdempotencyKeyReturnsSameExecution(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	req := CreateRequest{UID: 18, Language: "python", Code: "print(1)", IdempotencyKey: "idem-1"}
	first := env.mustCreate(t, req)
	second := env.mustCreate(t, req)
	if first.ID != second.ID {
		t.Fatalf("idempotent create returned %s then %s", first.ID, second.ID)
	}
	rows, err := env.store.ListExecutionsByUID(context.Background(), 18, 10)
	if err != nil {
		t.Fatalf("list executions: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("stored %d executions, want 1", len(rows))
	}
}

func TestExecutionTruncatesPreview(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{Stdout: strings.Repeat("x", 500)}, func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Execution.PreviewBytes = 32
	})
	exec := env.mustCreate(t, CreateRequest{UID: 19, Language: "python", Code: "print('x')"})
	terminal := env.waitTerminal(t, 19, exec.ID)
	if len(terminal.StdoutPreview) != 32 {
		t.Fatalf("preview length = %d, want 32", len(terminal.StdoutPreview))
	}
	if terminal.StdoutBytes != 500 {
		t.Fatalf("stdout bytes = %d, want 500", terminal.StdoutBytes)
	}
}

func TestExecutionEventsReplayHistory(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	exec := env.mustCreate(t, CreateRequest{UID: 20, Language: "python", Code: "print(1)"})
	env.waitTerminal(t, 20, exec.ID)

	history, ch, cancel, err := env.executions.Events(context.Background(), 20, exec.ID)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	defer cancel()
	types := make(map[string]bool)
	for _, ev := range history {
		types[ev.Type] = true
	}
	if !types["status"] || !types["stdout"] || !types["done"] {
		t.Fatalf("history event types = %v", types)
	}
	// The topic is closed, so the live channel is already closed.
	if _, open := <-ch; open {
		t.Fatal("live channel must be closed for a finished execution")
	}
	if _, _, _, err := env.executions.Events(context.Background(), 21, exec.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign events: want ErrForbidden, got %v", err)
	}
}

func TestExecutionReleasesAdmissionAfterCompletion(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	for i := 0; i < 3; i++ {
		exec := env.mustCreate(t, CreateRequest{UID: 22, Language: "python", Code: "print(1)"})
		env.waitTerminal(t, 22, exec.ID)
	}
	if global, queued := env.admission.Stats(); global != 0 || queued != 0 {
		t.Fatalf("admission state after completion = (%d,%d), want (0,0)", global, queued)
	}
}

func TestExecutionCollectsArtifacts(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	env.artifacts.SetCandidates(
		ArtifactCandidate{Name: "result.csv", SizeBytes: 120, SHA256: "sha-a", ContentType: "text/csv"},
		ArtifactCandidate{Name: "huge.bin", SizeBytes: 40 << 20}, // over artifacts.maxFileBytes
	)
	exec := env.mustCreate(t, CreateRequest{UID: 23, Language: "python", Code: "print(1)", ArtifactGlobs: []string{"/workspace/analysis/outputs/**"}})
	terminal := env.waitTerminal(t, 23, exec.ID)
	if terminal.Status != model.ExecStatusSucceeded {
		t.Fatalf("status = %s", terminal.Status)
	}
	rows, err := env.store.ListArtifactsByExecution(context.Background(), exec.ID)
	if err != nil {
		t.Fatalf("list artifacts: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "result.csv" || rows[0].SizeBytes != 120 {
		t.Fatalf("artifacts = %+v, want only result.csv", rows)
	}
	if !strings.Contains(rows[0].ObjectKey, exec.ArtifactPrefix) {
		t.Fatalf("object key %q must live under %q", rows[0].ObjectKey, exec.ArtifactPrefix)
	}
	usage, _ := env.quota.Usage(context.Background(), 23)
	if usage.ArtifactBytes != 120 {
		t.Fatalf("artifact bytes = %d, want 120", usage.ArtifactBytes)
	}
	view, err := env.executions.Get(context.Background(), 23, exec.ID)
	if err != nil {
		t.Fatalf("get view: %v", err)
	}
	if len(view.Artifacts) != 1 || !strings.HasPrefix(view.Artifacts[0].URL, "fake://") {
		t.Fatalf("artifact views = %+v", view.Artifacts)
	}
}

func TestExecutionDropsArtifactsOverQuota(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	if err := env.store.IncrementUsage(ctx, 24, day, repo.UsageDelta{ArtifactBytes: 50 << 20}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	env.artifacts.SetCandidates(ArtifactCandidate{Name: "out.txt", SizeBytes: 10})
	exec := env.mustCreate(t, CreateRequest{UID: 24, Language: "python", Code: "print(1)"})
	terminal := env.waitTerminal(t, 24, exec.ID)
	if terminal.Status != model.ExecStatusSucceeded {
		t.Fatalf("quota-denied artifacts must not fail the execution, status = %s", terminal.Status)
	}
	rows, _ := env.store.ListArtifactsByExecution(ctx, exec.ID)
	if len(rows) != 0 {
		t.Fatalf("artifacts persisted despite quota: %+v", rows)
	}
	audits, _ := env.store.ListAuditByExecution(ctx, exec.ID)
	found := false
	for _, a := range audits {
		if a.Action == model.AuditArtifactDeny {
			found = true
		}
	}
	if !found {
		t.Fatalf("artifact deny audit missing: %+v", audits)
	}
}
