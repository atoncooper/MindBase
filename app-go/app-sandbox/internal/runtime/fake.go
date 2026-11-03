package runtime

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
)

// FakeOptions tunes the canned behaviour of Fake.
type FakeOptions struct {
	Stdout      string
	Stderr      string
	ExitCode    int
	CreateDelay time.Duration
	ExecDelay   time.Duration
	// FailCreate / FailExec make the next calls fail with a generic error.
	FailCreate bool
	FailExec   bool
	// NotFound makes Get/Endpoint/Exec report ErrNotFound (simulates a sandbox
	// that was reclaimed out of band — the sweeper must mark it failed).
	NotFound bool
	// ExecFn overrides Exec entirely (timeouts, custom output, ...).
	ExecFn func(ctx context.Context, req ExecRequest) (*ExecResult, error)
}

// Fake is an in-process Runtime for tests and local demos. It keeps created
// sandboxes in memory, honours context cancellation (so timeouts are testable),
// and counts calls so tests can assert reuse/reclaim behaviour.
type Fake struct {
	mu        sync.Mutex
	options   FakeOptions
	sandboxes map[string]*Sandbox
	creates   int
	deletes   int
	execs     int
}

// NewFake returns a Fake with canned success output.
func NewFake() *Fake {
	return &Fake{
		options: FakeOptions{
			Stdout:   "hello from sandbox\n",
			ExitCode: 0,
		},
		sandboxes: make(map[string]*Sandbox),
	}
}

// NewFakeWith returns a Fake configured with opts.
func NewFakeWith(opts FakeOptions) *Fake {
	f := &Fake{options: opts, sandboxes: make(map[string]*Sandbox)}
	if f.options.Stdout == "" && opts.ExecFn == nil && !opts.FailExec {
		f.options.Stdout = "hello from sandbox\n"
	}
	return f
}

// Configure replaces the options (tests tweak behaviour between phases).
func (f *Fake) Configure(opts FakeOptions) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.options = opts
}

// Calls returns (creates, execs, deletes) counters.
func (f *Fake) Calls() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.creates, f.execs, f.deletes
}

// SandboxCount returns the number of live fake sandboxes.
func (f *Fake) SandboxCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sandboxes)
}

// Name implements Runtime.
func (f *Fake) Name() string { return "fake" }

// Probe implements Prober: the fake runtime is always reachable.
func (f *Fake) Probe(context.Context) error { return nil }

// Create implements Runtime.
func (f *Fake) Create(ctx context.Context, spec CreateSpec) (*Sandbox, error) {
	f.mu.Lock()
	opts := f.options
	f.mu.Unlock()
	if opts.FailCreate {
		return nil, errFakeCreate
	}
	if opts.CreateDelay > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(opts.CreateDelay):
		}
	}
	sb := &Sandbox{
		ID:        "fake-" + uuid.NewString(),
		State:     "ready",
		Endpoint:  "fake://sandbox/" + uuid.NewString(),
		CreatedAt: time.Now().UTC(),
	}
	f.mu.Lock()
	f.sandboxes[sb.ID] = sb
	f.creates++
	f.mu.Unlock()
	out := *sb
	return &out, nil
}

// Get implements Runtime.
func (f *Fake) Get(_ context.Context, sandboxID string) (*Sandbox, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.options.NotFound {
		return nil, ErrNotFound
	}
	sb, ok := f.sandboxes[sandboxID]
	if !ok {
		return nil, ErrNotFound
	}
	out := *sb
	return &out, nil
}

// Delete implements Runtime (idempotent).
func (f *Fake) Delete(_ context.Context, sandboxID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sandboxes, sandboxID)
	f.deletes++
	return nil
}

// Exec implements Runtime.
func (f *Fake) Exec(ctx context.Context, req ExecRequest) (*ExecResult, error) {
	f.mu.Lock()
	opts := f.options
	_, exists := f.sandboxes[req.SandboxID]
	f.execs++
	f.mu.Unlock()

	if opts.NotFound || !exists {
		return nil, ErrNotFound
	}
	if opts.ExecFn != nil {
		return opts.ExecFn(ctx, req)
	}
	started := time.Now()
	if opts.ExecDelay > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(opts.ExecDelay):
		}
	} else {
		// Even the no-delay path must observe cancellation (cancel tests).
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}
	if opts.FailExec {
		return nil, errFakeExec
	}
	return &ExecResult{
		ExitCode:    opts.ExitCode,
		Stdout:      opts.Stdout,
		Stderr:      opts.Stderr,
		StdoutBytes: int64(len(opts.Stdout)),
		StderrBytes: int64(len(opts.Stderr)),
		Duration:    time.Since(started),
	}, nil
}

// Endpoint implements Runtime.
func (f *Fake) Endpoint(ctx context.Context, sandboxID string) (string, error) {
	sb, err := f.Get(ctx, sandboxID)
	if err != nil {
		return "", err
	}
	return sb.Endpoint, nil
}
