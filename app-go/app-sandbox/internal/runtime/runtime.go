// Package runtime abstracts the sandbox backend. The control plane only sees
// Create/Get/Delete/Exec/Endpoint; the fake implementation runs locally (tests,
// demos) and the opensandbox adapter talks HTTP to the OpenSandbox lifecycle
// server + execd.
package runtime

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound means the sandbox does not exist (already reclaimed / never made).
var ErrNotFound = errors.New("runtime: sandbox not found")

// ErrTimeout means the runtime did not finish the call before its deadline.
var ErrTimeout = errors.New("runtime: timeout")

// File is one input file materialized before execution.
type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// CreateSpec describes one sandbox creation request.
type CreateSpec struct {
	UID       int64
	ProjectID string
	Purpose   string
	SpecHash  string
	Image     string
	CPU       string
	Memory    string
	Env       map[string]string
	// Timeout is the sandbox lifetime requested from the backend (absolute TTL).
	// Zero means the backend default. The control plane sets it from the lease TTL.
	Timeout time.Duration
}

// Sandbox is the runtime view of one sandbox instance.
type Sandbox struct {
	ID        string
	State     string
	Endpoint  string
	CreatedAt time.Time
}

// ExecRequest is one code execution inside a sandbox.
type ExecRequest struct {
	SandboxID string
	Language  string
	Code      string
	Files     []File
	Timeout   time.Duration
}

// ExecResult is the outcome of an execution.
type ExecResult struct {
	ExitCode int
	// Stdout / Stderr are captured output, bounded by the adapter to avoid
	// unbounded memory growth from a chatty program. StdoutBytes/StderrBytes are
	// the real output sizes (may exceed len(Stdout)/len(Stderr)).
	Stdout      string
	Stderr      string
	StdoutBytes int64
	StderrBytes int64
	Duration    time.Duration
	TimedOut    bool
}

// Prober is implemented by runtimes that can report backend reachability. It
// backs the /ready probe so Kubernetes stops routing to a control plane whose
// sandbox backend is down (Create would fail anyway).
type Prober interface {
	Probe(ctx context.Context) error
}

// Runtime is the backend contract every implementation must satisfy.
type Runtime interface {
	// Name identifies the backend (persisted on leases/audit rows).
	Name() string
	Create(ctx context.Context, spec CreateSpec) (*Sandbox, error)
	Get(ctx context.Context, sandboxID string) (*Sandbox, error)
	// Delete is idempotent: deleting a missing sandbox returns nil.
	Delete(ctx context.Context, sandboxID string) error
	Exec(ctx context.Context, req ExecRequest) (*ExecResult, error)
	Endpoint(ctx context.Context, sandboxID string) (string, error)
}
