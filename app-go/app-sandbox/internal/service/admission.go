package service

import (
	"context"
	"sync"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
)

// Admission bounds concurrent executions globally and per uid, with a bounded
// FIFO wait queue: full queue -> 503, queue wait timeout -> 429. It is the only
// thing that decides when an execution may start, so the runtime never sees
// more concurrent work than configured.
type Admission struct {
	maxConcurrent int
	maxPerUID     int
	queueSize     int
	queueTimeout  time.Duration
	metrics       *metrics.Metrics

	mu      sync.Mutex
	global  int
	perUID  map[int64]int
	waiters []*waiter
	closed  bool
}

type waiter struct {
	uid        int64
	granted    chan struct{}
	dispatched bool
}

// NewAdmission builds the admission controller from config.
func NewAdmission(cfg *config.Config, m *metrics.Metrics) *Admission {
	queueTimeout := cfg.AdmissionQueueTimeout()
	if queueTimeout <= 0 {
		queueTimeout = 30 * time.Second
	}
	return &Admission{
		maxConcurrent: cfg.Admission.MaxConcurrent,
		maxPerUID:     cfg.Admission.MaxPerUID,
		queueSize:     cfg.Admission.QueueSize,
		queueTimeout:  queueTimeout,
		metrics:       m,
		perUID:        make(map[int64]int),
	}
}

// Acquire waits for an execution slot for uid. The returned release func must be
// called exactly once (workers defer it). Errors: ErrQueueFull (503),
// ErrQueueTimeout (429) or the caller's context error.
func (a *Admission) Acquire(ctx context.Context, uid int64) (func(), error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, ErrQueueFull
	}
	if a.global < a.maxConcurrent && a.perUID[uid] < a.maxPerUID {
		a.global++
		a.perUID[uid]++
		a.mu.Unlock()
		a.count("granted")
		return a.releaseFunc(uid), nil
	}
	queueSize := a.queueSize
	if queueSize <= 0 || len(a.waiters) >= queueSize {
		a.mu.Unlock()
		a.count("rejected_full")
		return nil, ErrQueueFull
	}
	w := &waiter{uid: uid, granted: make(chan struct{})}
	a.waiters = append(a.waiters, w)
	a.mu.Unlock()
	a.count("queued")

	timer := time.NewTimer(a.queueTimeout)
	defer timer.Stop()
	select {
	case <-w.granted:
		a.count("granted")
		return a.releaseFunc(uid), nil
	case <-timer.C:
		if a.abandon(w) {
			a.count("rejected_timeout")
			return nil, ErrQueueTimeout
		}
		// Lost the race: a slot was granted between the timer firing and the
		// abandon, so this caller owns it and must release it eventually.
		a.count("granted")
		return a.releaseFunc(uid), nil
	case <-ctx.Done():
		if a.abandon(w) {
			return nil, ctx.Err()
		}
		a.count("granted")
		return a.releaseFunc(uid), nil
	}
}

// abandon removes a queued waiter. It returns false when the waiter was already
// dispatched (the caller then owns the granted slot).
func (a *Admission) abandon(w *waiter) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if w.dispatched {
		return false
	}
	for i, cand := range a.waiters {
		if cand == w {
			a.waiters = append(a.waiters[:i], a.waiters[i+1:]...)
			return true
		}
	}
	return true
}

// Release frees one slot and dispatches queued waiters that now fit.
func (a *Admission) Release(uid int64) {
	a.mu.Lock()
	if a.global > 0 {
		a.global--
	}
	if a.perUID[uid] > 1 {
		a.perUID[uid]--
	} else {
		delete(a.perUID, uid)
	}
	a.dispatchLocked()
	a.mu.Unlock()
}

func (a *Admission) dispatchLocked() {
	for !a.closed && a.global < a.maxConcurrent {
		picked := -1
		for i, w := range a.waiters {
			if a.perUID[w.uid] < a.maxPerUID {
				picked = i
				break
			}
		}
		if picked < 0 {
			return
		}
		w := a.waiters[picked]
		a.waiters = append(a.waiters[:picked], a.waiters[picked+1:]...)
		a.global++
		a.perUID[w.uid]++
		w.dispatched = true
		close(w.granted)
	}
}

// Close wakes every waiter with a full-queue error and rejects new work.
func (a *Admission) Close() {
	a.mu.Lock()
	a.closed = true
	waiters := a.waiters
	a.waiters = nil
	a.mu.Unlock()
	for _, w := range waiters {
		// Marking dispatched keeps Acquire's race handler honest: the channel is
		// closed without a slot, and Acquire's abandon() will return false...
		// so grant the slot instead and let the caller release it immediately.
		a.mu.Lock()
		w.dispatched = true
		a.global++
		a.perUID[w.uid]++
		close(w.granted)
		a.mu.Unlock()
	}
}

// Stats returns (in-flight, queued) for metrics and tests.
func (a *Admission) Stats() (int, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.global, len(a.waiters)
}

func (a *Admission) releaseFunc(uid int64) func() {
	var once sync.Once
	return func() {
		once.Do(func() { a.Release(uid) })
	}
}

func (a *Admission) count(result string) {
	if a.metrics != nil {
		a.metrics.Inc("sandbox_admission_total", map[string]string{"result": result})
	}
}
