package tests

import (
	"context"
	"errors"
	"strings"
	"testing"

	. "app-sandbox/internal/service"
	"app-sandbox/internal/runtime"
)

func TestExecutionOutputPagingAndOwnership(t *testing.T) {
	stdout := strings.Repeat("hello-", 20)
	env := newTestEnv(t, runtime.FakeOptions{Stdout: stdout}, nil)
	exec, err := env.executions.Create(context.Background(), CreateRequest{
		UID:       7,
		ProjectID: "p1",
		Purpose:   "chat",
		Language:  "python",
		Code:      "print(1)",
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	env.waitTerminal(t, 7, exec.ID)

	first, err := env.executions.Output(context.Background(), 7, exec.ID, "stdout", 0, 10)
	if err != nil {
		t.Fatalf("output: %v", err)
	}
	if first.Content != stdout[:10] || !first.HasMore || first.NextOffset != 10 {
		t.Fatalf("first page = %+v", first)
	}
	last, err := env.executions.Output(context.Background(), 7, exec.ID, "stdout", int64(len(stdout)), 10)
	if err != nil {
		t.Fatalf("last output: %v", err)
	}
	if last.Content != "" || last.HasMore || last.NextOffset != int64(len(stdout)) {
		t.Fatalf("last page = %+v", last)
	}

	if _, err := env.executions.Output(context.Background(), 8, exec.ID, "stdout", 0, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign uid error = %v, want NotFound", err)
	}
}

func TestExecutionOutputRejectsActive(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{ExecDelay: 200_000_000}, nil) // 200ms
	exec, err := env.executions.Create(context.Background(), CreateRequest{
		UID: 7, Language: "python", Code: "print(1)", TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := env.executions.Output(context.Background(), 7, exec.ID, "stdout", 0, 10); !errors.Is(err, ErrValidation) {
		t.Fatalf("active output error = %v, want validation", err)
	}
	env.waitTerminal(t, 7, exec.ID)
}
