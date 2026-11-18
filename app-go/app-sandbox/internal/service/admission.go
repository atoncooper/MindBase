package service

import (
	"context"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
)

// Admission bounds concurrent executions globally and per uid, with a bounded
// weighted-FIFO wait queue and an optional memory budget:
//
//   - hard caps: maxConcurrent, maxPerUid, maxMemoryBytes;
//   - queue: bounded FIFO by virtual finish time; higher-weight callers
//     (VIP/SVIP) get proportionally more service while aging prevents starvation;
//   - full queue -> 503, queue wait timeout -> 429.
//
// It is the only thing that decides when an execution may start, so the runtime
// never sees more concurrent work than configured.
type Admission struct {
	maxConcurrent int
	maxPerUID     int
	queueSize     int
	queueTimeout  time.Duration
	maxMemory     int64
	perExecMemory int64
	weights       map[string]float64
	metrics       *metrics.Metrics

	mu          sync.Mutex
	global      int
	perUID      map[int64]int
	memoryInUse int64
	waiters     []*waiter
	virtualTime float64
	lastFinish  map[int64]float64
	seq         uint64
	closed      bool
}

type waiter struct {
	uid        int64
	weight     float64
	finish     float64
	seq        uint64
	granted    chan struct{}
	dispatched bool
}

// NewAdmission builds the admission controller from config.
func NewAdmission(cfg *config.Config, m *metrics.Metrics) *Admission {
	queueTimeout := cfg.AdmissionQueueTimeout()
	if queueTimeout <= 0 {
		queueTimeout = 30 * time.Second
	}
	perExec := cfg.Admission.MemoryPerExecutionBytes
	if perExec <= 0 {
		perExec = parseBytes(cfg.Runtime.Resources.Memory)
	}
	weights := map[string]float64{"free": 1, "vip": 2, "svip": 4}
	for tier, weight := range cfg.Admission.Weights {
		if weight > 0 {
			weights[strings.ToLower(tier)] = weight
		}
	}
	return &Admission{
		maxConcurrent: cfg.Admission.MaxConcurrent,
		maxPerUID:     cfg.Admission.MaxPerUID,
		queueSize:     cfg.Admission.QueueSize,
		queueTimeout:  queueTimeout,
		maxMemory:     cfg.Admission.MaxMemoryBytes,
		perExecMemory: perExec,
		weights:       weights,
		metrics:       m,
		perUID:        make(map[int64]int),
		lastFinish:    make(map[int64]float64),
	}
}

// Acquire waits for an execution slot for uid. weight is optional (default 1);
// VIP/SVIP callers pass their service weight. The returned release func must be
// called exactly once. Errors: ErrQueueFull (503), ErrQueueTimeout (429) or the
// caller's context error.
func (a *Admission) Acquire(ctx context.Context, uid int64, weight ...float64) (func(), error) {
	w := 1.0
	if len(weight) > 0 && weight[0] > 0 {
		w = weight[0]
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, ErrQueueFull
	}
	if a.canGrantLocked(uid) {
		a.grantLocked(uid)
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
	slot := &waiter{
		uid:     uid,
		weight:  w,
		seq:     a.seq,
		granted: make(chan struct{}),
		finish:  a.virtualFinishLocked(uid, w),
	}
	a.seq++
	a.waiters = append(a.waiters, slot)
	a.mu.Unlock()
	a.count("queued")

	timer := time.NewTimer(a.queueTimeout)
	defer timer.Stop()
	select {
	case <-slot.granted:
		a.count("granted")
		return a.releaseFunc(uid), nil
	case <-timer.C:
		if a.abandon(slot) {
			a.count("rejected_timeout")
			return nil, ErrQueueTimeout
		}
		a.count("granted")
		return a.releaseFunc(uid), nil
	case <-ctx.Done():
		if a.abandon(slot) {
			return nil, ctx.Err()
		}
		a.count("granted")
		return a.releaseFunc(uid), nil
	}
}

// abandon removes a queued waiter. It returns false when the waiter was already
// dispatched (the caller then owns the granted slot).
func (a *Admission) abandon(slot *waiter) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if slot.dispatched {
		return false
	}
	for i, cand := range a.waiters {
		if cand == slot {
			a.waiters = append(a.waiters[:i], a.waiters[i+1:]...)
			return true
		}
	}
	return true
}

// Release frees one slot and dispatches eligible waiters.
func (a *Admission) Release(uid int64) {
	a.mu.Lock()
	a.releaseLocked(uid)
	a.dispatchLocked()
	a.mu.Unlock()
}

func (a *Admission) releaseLocked(uid int64) {
	if a.global > 0 {
		a.global--
	}
	if a.perUID[uid] > 1 {
		a.perUID[uid]--
	} else {
		delete(a.perUID, uid)
	}
	if a.perExecMemory > 0 && a.memoryInUse >= a.perExecMemory {
		a.memoryInUse -= a.perExecMemory
	} else {
		a.memoryInUse = 0
	}
}

func (a *Admission) canGrantLocked(uid int64) bool {
	if a.global >= a.maxConcurrent || a.perUID[uid] >= a.maxPerUID {
		return false
	}
	if a.maxMemory > 0 && a.perExecMemory > 0 && a.memoryInUse+a.perExecMemory > a.maxMemory {
		return false
	}
	return true
}

func (a *Admission) grantLocked(uid int64) {
	a.global++
	a.perUID[uid]++
	if a.perExecMemory > 0 {
		a.memoryInUse += a.perExecMemory
	}
}

// virtualFinishLocked computes the WFQ finish time for a new waiter.
func (a *Admission) virtualFinishLocked(uid int64, weight float64) float64 {
	if weight <= 0 {
		weight = 1
	}
	start := math.Max(a.virtualTime, a.lastFinish[uid])
	finish := start + 1/weight
	a.lastFinish[uid] = finish
	return finish
}

func (a *Admission) dispatchLocked() {
	for !a.closed && a.global < a.maxConcurrent && a.memoryAvailableLocked() {
		picked := -1
		var bestFinish float64
		var bestSeq uint64
		for i, w := range a.waiters {
			if a.perUID[w.uid] >= a.maxPerUID {
				continue
			}
			if picked < 0 || w.finish < bestFinish || (w.finish == bestFinish && w.seq < bestSeq) {
				picked = i
				bestFinish = w.finish
				bestSeq = w.seq
			}
		}
		if picked < 0 {
			return
		}
		w := a.waiters[picked]
		a.waiters = append(a.waiters[:picked], a.waiters[picked+1:]...)
		a.grantLocked(w.uid)
		a.virtualTime = math.Max(a.virtualTime, w.finish)
		w.dispatched = true
		close(w.granted)
	}
}

func (a *Admission) memoryAvailableLocked() bool {
	return a.maxMemory <= 0 || a.perExecMemory <= 0 || a.memoryInUse+a.perExecMemory <= a.maxMemory
}

// Close wakes every waiter with a full-queue error and rejects new work.
func (a *Admission) Close() {
	a.mu.Lock()
	a.closed = true
	waiters := a.waiters
	a.waiters = nil
	a.mu.Unlock()
	for _, w := range waiters {
		a.mu.Lock()
		w.dispatched = true
		a.grantLocked(w.uid)
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

// MemoryStats returns the memory budget counters for /metrics.
func (a *Admission) MemoryStats() (inUse, max int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.memoryInUse, a.maxMemory
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

// parseBytes parses Docker-style memory strings ("256Mi", "1Gi", "512M").
func parseBytes(raw string) int64 {
	value := strings.TrimSpace(strings.ToUpper(raw))
	if value == "" {
		return 0
	}
	multiplier := int64(1)
	switch {
	case strings.HasSuffix(value, "GI"):
		multiplier = 1 << 30
		value = strings.TrimSuffix(value, "GI")
	case strings.HasSuffix(value, "MI"):
		multiplier = 1 << 20
		value = strings.TrimSuffix(value, "MI")
	case strings.HasSuffix(value, "G"):
		multiplier = 1_000_000_000
		value = strings.TrimSuffix(value, "G")
	case strings.HasSuffix(value, "M"):
		multiplier = 1_000_000
		value = strings.TrimSuffix(value, "M")
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || number <= 0 {
		return 0
	}
	return int64(number * float64(multiplier))
}

// WeightForTier maps a membership tier to the WFQ service weight.
func (a *Admission) WeightForTier(tier string) float64 {
	if weight, ok := a.weights[strings.ToLower(tier)]; ok {
		return weight
	}
	return 1
}
