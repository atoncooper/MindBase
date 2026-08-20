// Package executor provides the task-handler registry that decouples the
// scheduler from business logic (M2). A task's task_type maps to a Handler;
// the scheduler only knows how to dispatch, never what a task does.
//
// Handlers receive a generic Task view (ID + payload + meta), never the
// concrete business model: the scheduler adapts the persisted task into a Task
// at dispatch time, so handlers (and the Lua executor) stay model-agnostic.
//
// Handlers live in the packages that own the business logic (e.g. the quiz
// handler in internal/service) and register themselves here at startup.
package executor

import (
	"context"
	"errors"
	"sort"
	"sync"
)

// ErrAsync signals that the handler started an asynchronous phase (e.g. quiz
// generation): the task moved out of pending (e.g. to generating) and a
// poller is responsible for finalizing it. Not a failure.
var ErrAsync = errors.New("executor: async")

// ErrRetry signals a transient failure: the scheduler applies the task's
// max_retry / next_retry_at policy (schedule a retry, or fail the task).
var ErrRetry = errors.New("executor: retry")

// Task is the generic, model-agnostic view of a task handed to a Handler. The
// scheduler adapts its persisted task into this shape at dispatch time, so
// handlers (and the Lua executor) never depend on a concrete business model.
//
// Meta carries model-specific fields the scheduler wants to expose read-only
// (e.g. uid/prompt for quiz); payload is the arbitrary task parameter JSON.
type Task struct {
	ID      string
	Payload []byte
	Meta    map[string]any
}

// Handler processes one task trigger. It must be idempotent (the scheduler may
// re-dispatch the same trigger after a crash). Return values:
//
//   nil       — success; the task reached a terminal state (or is being
//               finalized by the poller on the success path)
//   ErrAsync  — the task moved to an async phase; a poller finalizes it
//   ErrRetry  — transient failure; apply retry policy
//   other err — hard failure; apply retry policy (may fail the task)
type Handler func(ctx context.Context, task Task) error

// Registry maps task types to handlers.
type Registry struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

// Register binds a task type to a handler. A later Register for the same type
// replaces the previous handler.
func (r *Registry) Register(taskType string, h Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[taskType] = h
}

// Handler returns the handler registered for a task type, if any.
func (r *Registry) Handler(taskType string) (Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	h, ok := r.handlers[taskType]
	return h, ok
}

// Types returns the registered task types, sorted for determinism.
func (r *Registry) Types() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.handlers))
	for t := range r.handlers {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}
