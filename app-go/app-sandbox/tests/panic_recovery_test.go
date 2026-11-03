package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"testing"

	"app-sandbox/internal/model"
	"app-sandbox/internal/runtime"
)

// A panicking runtime adapter must not take down the control plane: the worker
// has to persist a failed execution, publish a terminal event and keep serving
// later executions.
func TestWorkerPanicIsContained(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{
		ExecFn: func(context.Context, runtime.ExecRequest) (*runtime.ExecResult, error) {
			panic("runtime adapter exploded")
		},
	}, nil)

	first := env.mustCreate(t, CreateRequest{UID: 7, Language: "python", Code: "print(1)", TimeoutMS: 1000})
	done := env.waitTerminal(t, 7, first.ID)
	if done.Status != model.ExecStatusFailed || done.ErrorCode != "internal_error" {
		t.Fatalf("panicking execution = %+v, want failed/internal_error", done)
	}

	// The service must still be usable afterwards.
	env.rt.Configure(runtime.FakeOptions{Stdout: "ok\n"})
	second := env.mustCreate(t, CreateRequest{UID: 7, Language: "python", Code: "print(2)", TimeoutMS: 1000})
	next := env.waitTerminal(t, 7, second.ID)
	if next.Status != model.ExecStatusSucceeded {
		t.Fatalf("post-panic execution = %+v, want succeeded", next)
	}
}
