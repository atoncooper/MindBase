package queue

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// PersistentQueue is a durable, concurrency-safe weighted FIFO queue built on
// the in-memory Queue core plus a Store (WAL by default).
//
// Ordering and delivery guarantees (at-least-once):
//
//   - Enqueue is durable before it returns: the enqueue record is synced to
//     the store before the item becomes visible to Dequeue.
//   - Dequeue pops the item in memory, then syncs the dequeue record. If the
//     sync fails the pop is rolled back. A crash between the pop and the
//     sync re-queues the item on restart, so a consumer may see the same
//     item twice — dedupe by Item.ID on the consumer side.
type PersistentQueue struct {
	mu    sync.Mutex
	q     *Queue
	store Store
	now   func() int64
}

// OpenPersistent opens (creating if needed) a WAL-backed persistent queue at
// path and replays any existing log to restore its state.
func OpenPersistent(path string, opts ...WALOption) (*PersistentQueue, error) {
	store, err := NewWALStore(path, opts...)
	if err != nil {
		return nil, err
	}
	pq, err := NewPersistentQueue(NewQueue(), store)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	return pq, nil
}

// NewPersistentQueue wraps a Queue core with an arbitrary Store, replaying the
// store into the queue. This is the extension point for non-WAL backends
// (e.g. a MySQL-backed Store).
func NewPersistentQueue(q *Queue, store Store) (*PersistentQueue, error) {
	if q == nil || store == nil {
		return nil, errors.New("queue: nil queue or store")
	}
	pq := &PersistentQueue{
		q:     q,
		store: store,
		now:   func() int64 { return time.Now().UnixNano() },
	}
	pq.mu.Lock()
	defer pq.mu.Unlock()
	if err := store.Replay(func(rec Record) error { return pq.apply(rec) }); err != nil {
		return nil, err
	}
	return pq, nil
}

// Enqueue durably enqueues an item. The item becomes visible to Dequeue only
// after its record is persisted.
func (p *PersistentQueue) Enqueue(it Item) error {
	it, err := normalizeItem(it)
	if err != nil {
		return err
	}
	rec := Record{
		Op:      OpEnqueue,
		ItemID:  it.ID,
		Weight:  it.Weight,
		Cost:    it.Cost,
		FlowKey: it.FlowKey,
		Payload: it.Payload,
		AtNanos: p.now(),
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.store.Append(rec); err != nil {
		return fmt.Errorf("queue: persist enqueue: %w", err)
	}
	// normalizeItem above guarantees enqueueLocked cannot fail here (heap push
	// never errors), so the WAL and memory never diverge.
	if err := p.q.enqueueLocked(it); err != nil {
		return fmt.Errorf("queue: apply enqueue: %w", err)
	}
	return nil
}

// Dequeue removes and returns the item with the smallest virtual finish time.
// The dequeue record is synced after the pop; on sync failure the pop is
// rolled back so the item stays queued.
func (p *PersistentQueue) Dequeue() (Item, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, st, err := p.q.dequeueLocked()
	if err != nil {
		return Item{}, err
	}
	rec := Record{Op: OpDequeue, ItemID: e.id, AtNanos: p.now()}
	if err := p.store.Append(rec); err != nil {
		p.q.restoreUndo(e, st)
		return Item{}, fmt.Errorf("queue: persist dequeue: %w", err)
	}
	return itemFromEntry(e), nil
}

// Peek returns the item that would be dequeued next, without removing it.
func (p *PersistentQueue) Peek() (Item, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.q.Peek()
}

// Len returns the number of queued items.
func (p *PersistentQueue) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.q.Len()
}

// VirtualTime exposes the current virtual clock value (debugging aid).
func (p *PersistentQueue) VirtualTime() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.q.VirtualTime()
}

// Close releases the underlying store.
func (p *PersistentQueue) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.store.Close()
}

// apply replays one record into the in-memory queue. Enqueue re-runs the same
// finish-time computation (deterministic given the op sequence); Dequeue pops
// the head and cross-checks its ItemID against the record to catch log
// corruption (a replay whose pop order diverges means the log is inconsistent).
func (p *PersistentQueue) apply(rec Record) error {
	switch rec.Op {
	case OpEnqueue:
		return p.q.enqueueLocked(Item{
			ID:      rec.ItemID,
			Weight:  rec.Weight,
			Cost:    rec.Cost,
			FlowKey: rec.FlowKey,
			Payload: rec.Payload,
		})
	case OpDequeue:
		e, _, err := p.q.dequeueLocked()
		if err != nil {
			return fmt.Errorf("queue: replay dequeue %q: %w", rec.ItemID, err)
		}
		if e.id != rec.ItemID {
			return fmt.Errorf("queue: replay mismatch: wal dequeue %q but head is %q (corrupt log)", rec.ItemID, e.id)
		}
		return nil
	default:
		return fmt.Errorf("queue: unknown op %d", rec.Op)
	}
}
