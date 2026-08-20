// Package queue implements a persistent weighted FIFO queue based on
// Self-Clocked Fair Queueing (SCFQ), a practical, event-driven form of
// Weighted Fair Queuing (WFQ).
//
// # Semantics
//
//   - Every item carries a weight (>0) and a cost (service units, default 1).
//   - Items are dequeued in order of their virtual finish time
//     F = max(F_last_of_flow, V) + cost/weight, where V is the virtual clock.
//   - Heavier weight => smaller finish-time increment => served sooner.
//   - Items sharing a FlowKey are strictly FIFO, regardless of weight.
//   - An empty FlowKey means each item is its own flow: ordering is driven
//     purely by weight and cost (and arrival order on ties).
//   - Equal finish times are broken by arrival order (global sequence), so
//     equal-weight equal-cost items behave exactly like a plain FIFO queue.
//
// The virtual clock advances to the finish time of the served item on every
// Dequeue and resets to zero when the queue empties (the SCFQ rule). The whole
// algorithm is deterministic and driven only by the operation sequence, which
// is what makes it replayable from a write-ahead log.
//
// # Delivery semantics
//
// By default (per-record fsync) Enqueue is durable before it returns: the
// record is synced before it becomes visible. With a delayed-flush policy
// (WALWithSyncInterval / WALWithMaxUnsynced) Enqueue returns once the record
// reaches the OS page cache; a process crash loses nothing, a power failure
// may lose at most the records since the last flush, and graceful Close
// always flushes everything pending.
//
// Dequeue pops in memory and then syncs the dequeue record; a crash in
// between re-queues the item on restart, so consumers may see an item twice
// (at-least-once) — dedupe by Item.ID on the consumer side.
package queue

import (
	"container/heap"
	"errors"
	"fmt"
	"math"

	"github.com/google/uuid"
)

// ErrEmpty is returned by Dequeue when the queue has no items.
var ErrEmpty = errors.New("queue: empty")

// ErrInvalid is returned by Enqueue for invalid items (bad weight/cost).
var ErrInvalid = errors.New("queue: invalid item")

// Item is a queued task.
type Item struct {
	ID      string  // unique id; auto-generated (uuid v4) when empty
	Weight  float64 // service weight; must be > 0. Higher = served sooner.
	Cost    float64 // service units (e.g. estimated processing time); default 1 when 0.
	FlowKey string  // optional flow grouping; same-flow items are strictly FIFO; empty = each item is its own flow
	Payload []byte  // arbitrary caller payload (opaque to the queue)
}

// entry is one queued item with its computed virtual finish time.
type entry struct {
	id      string
	weight  float64
	cost    float64
	flowKey string
	payload []byte
	finish  float64 // virtual finish time F
	seq     uint64  // global arrival order; tie-breaker for equal finish times
	heapIdx int     // position in the heap (maintained for future removal APIs)
}

// entryHeap is a min-heap ordered by (finish, seq).
type entryHeap []*entry

func (h entryHeap) Len() int { return len(h) }
func (h entryHeap) Less(i, j int) bool {
	if h[i].finish != h[j].finish {
		return h[i].finish < h[j].finish
	}
	return h[i].seq < h[j].seq
}
func (h entryHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].heapIdx = i
	h[j].heapIdx = j
}
func (h *entryHeap) Push(x any) {
	e := x.(*entry)
	e.heapIdx = len(*h)
	*h = append(*h, e)
}
func (h *entryHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	e.heapIdx = -1
	*h = old[:n-1]
	return e
}

// Queue is the in-memory SCFQ/WFQ core.
//
// It is a pure data structure: no I/O, no locking, not safe for concurrent
// use. Use PersistentQueue when you need durability and/or concurrency.
type Queue struct {
	h        entryHeap
	seq      uint64
	flowLast map[string]float64 // per-flow last finish time (F_{i-1})
	virtual  float64            // virtual clock V
}

// NewQueue returns an empty queue.
func NewQueue() *Queue {
	return &Queue{flowLast: make(map[string]float64)}
}

// Len returns the number of queued items.
func (q *Queue) Len() int { return len(q.h) }

// Empty reports whether the queue holds no items.
func (q *Queue) Empty() bool { return len(q.h) == 0 }

// VirtualTime returns the current virtual clock value (debugging aid).
func (q *Queue) VirtualTime() float64 { return q.virtual }

// Enqueue inserts an item with its weight/cost semantics.
func (q *Queue) Enqueue(it Item) error {
	return q.enqueueLocked(it)
}

func (q *Queue) enqueueLocked(it Item) error {
	it, err := normalizeItem(it)
	if err != nil {
		return err
	}
	q.seq++
	var finish float64
	if it.FlowKey == "" {
		// Each item is its own flow: no FIFO coupling, pure weight scheduling.
		finish = q.virtual + it.Cost/it.Weight
	} else {
		finish = math.Max(q.flowLast[it.FlowKey], q.virtual) + it.Cost/it.Weight
		q.flowLast[it.FlowKey] = finish
	}
	heap.Push(&q.h, &entry{
		id:      it.ID,
		weight:  it.Weight,
		cost:    it.Cost,
		flowKey: it.FlowKey,
		payload: it.Payload,
		finish:  finish,
		seq:     q.seq,
	})
	return nil
}

// Peek returns the item that would be dequeued next, without removing it.
func (q *Queue) Peek() (Item, bool) {
	if len(q.h) == 0 {
		return Item{}, false
	}
	return itemFromEntry(q.h[0]), true
}

// Dequeue removes and returns the item with the smallest virtual finish time.
// Returns ErrEmpty when the queue is empty.
func (q *Queue) Dequeue() (Item, error) {
	e, _, err := q.dequeueLocked()
	if err != nil {
		return Item{}, err
	}
	return itemFromEntry(e), nil
}

// popState captures enough state to undo a dequeue (used by the persistent
// wrapper when syncing the dequeue record to the store fails).
type popState struct {
	prevVirtual float64
}

// dequeueLocked pops the head entry and advances the virtual clock with the
// SCFQ rule: V := finish of the served item; V = 0 when the queue empties.
func (q *Queue) dequeueLocked() (*entry, *popState, error) {
	if len(q.h) == 0 {
		return nil, nil, ErrEmpty
	}
	e := heap.Pop(&q.h).(*entry)
	st := &popState{prevVirtual: q.virtual}
	q.virtual = e.finish
	if len(q.h) == 0 {
		q.virtual = 0
	}
	return e, st, nil
}

// restoreUndo re-inserts a popped entry and restores the virtual clock,
// reversing the effect of dequeueLocked. The re-pushed entry was the previous
// minimum, so the heap invariant holds. flowLast is untouched by dequeue, so
// no per-flow state needs restoring.
func (q *Queue) restoreUndo(e *entry, st *popState) {
	heap.Push(&q.h, e)
	q.virtual = st.prevVirtual
}

func itemFromEntry(e *entry) Item {
	return Item{
		ID:      e.id,
		Weight:  e.weight,
		Cost:    e.cost,
		FlowKey: e.flowKey,
		Payload: e.payload,
	}
}

// normalizeItem validates an item and fills defaults (uuid ID, cost = 1).
func normalizeItem(it Item) (Item, error) {
	if it.ID == "" {
		it.ID = uuid.NewString()
	}
	if it.Weight <= 0 || math.IsNaN(it.Weight) || math.IsInf(it.Weight, 0) {
		return Item{}, fmt.Errorf("%w: weight must be a positive finite number, got %v", ErrInvalid, it.Weight)
	}
	if it.Cost < 0 || math.IsNaN(it.Cost) || math.IsInf(it.Cost, 0) {
		return Item{}, fmt.Errorf("%w: cost must be a non-negative finite number, got %v", ErrInvalid, it.Cost)
	}
	if it.Cost == 0 {
		it.Cost = 1
	}
	return it, nil
}
