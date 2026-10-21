// Package circuit — a minimal per-process circuit breaker for downstream
// gateways (Higress chat/embedding calls). When a dependency starts failing
// consistently, failing FAST and leaving work in the durable outbox (the
// janitor's bounded retry re-runs it after backoff) is strictly better than
// hammering the gateway and dragging every worker into timeout waits.
//
// States: closed (normal) → open after `threshold` consecutive failures →
// half-open probes allowed once `cooldown` has elapsed → success closes it,
// failure re-arms the cooldown. Not distributed: one breaker per process —
// with N replicas the gateway still sees at most N probe attempts per
// cooldown window, which is the point.
package circuit

import (
	"errors"
	"sync"
	"time"
)

// ErrOpen — the breaker is open; fail fast and leave the durable queue to
// retry later.
var ErrOpen = errors.New("upstream circuit open — failing fast")

type Breaker struct {
	mu        sync.Mutex
	fails     int
	openedAt  time.Time
	threshold int
	cooldown  time.Duration
}

// New builds a breaker that opens after `threshold` consecutive failures and
// stays open for `cooldown` before allowing a half-open probe.
func New(threshold int, cooldown time.Duration) *Breaker {
	if threshold <= 0 {
		threshold = 1
	}
	if cooldown <= 0 {
		cooldown = 30 * time.Second
	}
	return &Breaker{threshold: threshold, cooldown: cooldown}
}

// Allow reports whether a call may proceed right now.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fails < b.threshold {
		return true
	}
	// half-open: exactly one probe window per cooldown; a failed probe
	// re-arms openedAt in OnFailure.
	return time.Since(b.openedAt) >= b.cooldown
}

func (b *Breaker) OnSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.fails = 0
}

func (b *Breaker) OnFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.fails++
	if b.fails >= b.threshold {
		b.openedAt = time.Now()
	}
}
