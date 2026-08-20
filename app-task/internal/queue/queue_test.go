package queue

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// opQueue is the common interface satisfied by both Queue and PersistentQueue.
type opQueue interface {
	Enqueue(Item) error
	Dequeue() (Item, error)
	Len() int
}

func mustEnqueue(t *testing.T, q *Queue, it Item) {
	t.Helper()
	if err := q.Enqueue(it); err != nil {
		t.Fatalf("enqueue %q: %v", it.ID, err)
	}
}

func mustEnqueueP(t *testing.T, pq *PersistentQueue, it Item) {
	t.Helper()
	if err := pq.Enqueue(it); err != nil {
		t.Fatalf("enqueue %q: %v", it.ID, err)
	}
}

func mustQEnq(t *testing.T, q opQueue, it Item) {
	t.Helper()
	if err := q.Enqueue(it); err != nil {
		t.Fatalf("enqueue %q: %v", it.ID, err)
	}
}

func drainIDs(q opQueue) ([]string, error) {
	var ids []string
	for q.Len() > 0 {
		it, err := q.Dequeue()
		if err != nil {
			return nil, err
		}
		ids = append(ids, it.ID)
	}
	return ids, nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// applyOps replays a fixed mixed scenario (weights/flows/costs with
// interleaved dequeues) onto any opQueue. Deterministic by construction.
func applyOps(t *testing.T, q opQueue) {
	t.Helper()
	mustQEnq(t, q, Item{ID: "a", Weight: 1, Cost: 1})
	mustQEnq(t, q, Item{ID: "b", Weight: 10, Cost: 1})
	mustQEnq(t, q, Item{ID: "c", FlowKey: "f", Weight: 5, Cost: 2})
	if _, err := q.Dequeue(); err != nil {
		t.Fatal(err)
	}
	mustQEnq(t, q, Item{ID: "d", FlowKey: "f", Weight: 1, Cost: 1})
	if _, err := q.Dequeue(); err != nil {
		t.Fatal(err)
	}
	mustQEnq(t, q, Item{ID: "e", Weight: 1, Cost: 3})
}

// ── core semantics ──

func TestFIFOForEqualWeights(t *testing.T) {
	q := NewQueue()
	const n = 100
	for i := 0; i < n; i++ {
		mustEnqueue(t, q, Item{ID: fmt.Sprintf("i%03d", i), Weight: 1, Cost: 1})
	}
	if q.Len() != n {
		t.Fatalf("len = %d, want %d", q.Len(), n)
	}
	ids, err := drainIDs(q)
	if err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		want := fmt.Sprintf("i%03d", i)
		if id != want {
			t.Fatalf("position %d = %q, want %q (FIFO broken)", i, id, want)
		}
	}
	if !q.Empty() {
		t.Fatal("queue should be empty after drain")
	}
	if _, err := q.Dequeue(); !errors.Is(err, ErrEmpty) {
		t.Fatalf("dequeue on empty: want ErrEmpty, got %v", err)
	}
}

func TestHeavyWeightServedFirst(t *testing.T) {
	q := NewQueue()
	mustEnqueue(t, q, Item{ID: "light", Weight: 1, Cost: 1})  // F = 1
	mustEnqueue(t, q, Item{ID: "heavy", Weight: 10, Cost: 1}) // F = 0.1
	it, ok := q.Peek()
	if !ok || it.ID != "heavy" {
		t.Fatalf("peek = %q, want heavy (weight must preempt)", it.ID)
	}
	it, err := q.Dequeue()
	if err != nil || it.ID != "heavy" {
		t.Fatalf("first dequeue = %q, want heavy", it.ID)
	}
}

func TestCostScalesFinishTime(t *testing.T) {
	q := NewQueue()
	mustEnqueue(t, q, Item{ID: "big", Weight: 1, Cost: 10})   // F = 10
	mustEnqueue(t, q, Item{ID: "small", Weight: 10, Cost: 1}) // F = 0.1
	it, _ := q.Peek()
	if it.ID != "small" {
		t.Fatalf("peek = %q, want small", it.ID)
	}
}

func TestSameFlowStrictFIFO(t *testing.T) {
	q := NewQueue()
	// Same flow 'f': a1 (heavy) then a2 (light) — flow FIFO wins over weight.
	mustEnqueue(t, q, Item{ID: "a1", FlowKey: "f", Weight: 10, Cost: 1}) // F = 0.1
	mustEnqueue(t, q, Item{ID: "b", FlowKey: "g", Weight: 1, Cost: 1})   // F = 1.0
	mustEnqueue(t, q, Item{ID: "a2", FlowKey: "f", Weight: 1, Cost: 1})  // F = max(0.1,0)+1 = 1.1
	ids, err := drainIDs(q)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a1", "b", "a2"}
	if !equalStrings(ids, want) {
		t.Fatalf("order = %v, want %v", ids, want)
	}
}

func TestVirtualClockStopsPreemption(t *testing.T) {
	// SCFQ rule: V advances to the served item's finish time, so a heavy item
	// arriving during service cannot jump ahead of an already-queued light item.
	q := NewQueue()
	mustEnqueue(t, q, Item{ID: "a", Weight: 1, Cost: 1}) // F = 1
	mustEnqueue(t, q, Item{ID: "b", Weight: 1, Cost: 1}) // F = 1 (seq later)
	if _, err := q.Dequeue(); err != nil {
		t.Fatal(err)
	} // pops a; V := 1
	mustEnqueue(t, q, Item{ID: "c", Weight: 10, Cost: 1}) // F = max(0, 1)+0.1 = 1.1
	it, _ := q.Peek()
	if it.ID != "b" {
		t.Fatalf("peek = %q, want b (V advance must block preemption)", it.ID)
	}
	ids, _ := drainIDs(q)
	if !equalStrings(ids, []string{"b", "c"}) {
		t.Fatalf("order = %v, want [b c]", ids)
	}
}

func TestIdleResetsVirtualClock(t *testing.T) {
	q := NewQueue()
	mustEnqueue(t, q, Item{ID: "a", Weight: 1, Cost: 5})
	if _, err := q.Dequeue(); err != nil {
		t.Fatal(err)
	}
	if v := q.VirtualTime(); v != 0 {
		t.Fatalf("virtual time after idle = %v, want 0", v)
	}
}

func TestInvalidItemsRejected(t *testing.T) {
	cases := []Item{
		{ID: "x", Weight: 0},
		{ID: "x", Weight: -1},
		{ID: "x", Weight: math.NaN()},
		{ID: "x", Weight: math.Inf(1)},
		{ID: "x", Weight: 1, Cost: -1},
		{ID: "x", Weight: 1, Cost: math.NaN()},
		{ID: "x", Weight: 1, Cost: math.Inf(-1)},
	}
	for _, it := range cases {
		if err := NewQueue().Enqueue(it); !errors.Is(err, ErrInvalid) {
			t.Fatalf("enqueue %+v: want ErrInvalid, got %v", it, err)
		}
	}
}

func TestAutoIDAndDefaultCost(t *testing.T) {
	q := NewQueue()
	mustEnqueue(t, q, Item{Weight: 1})
	it, _ := q.Dequeue()
	if it.ID == "" {
		t.Fatal("empty ID was not auto-generated")
	}
	if it.Cost != 1 {
		t.Fatalf("default cost = %v, want 1", it.Cost)
	}
}

func TestRestoreUndo(t *testing.T) {
	q := NewQueue()
	mustEnqueue(t, q, Item{ID: "a", Weight: 10, Cost: 1}) // F = 0.1
	mustEnqueue(t, q, Item{ID: "b", Weight: 1, Cost: 1})  // F = 1.0
	e, st, err := q.dequeueLocked()
	if err != nil {
		t.Fatal(err)
	}
	if e.id != "a" {
		t.Fatalf("popped %q, want a", e.id)
	}
	q.restoreUndo(e, st)
	if q.Len() != 2 {
		t.Fatalf("len after restore = %d, want 2", q.Len())
	}
	it, _ := q.Peek()
	if it.ID != "a" {
		t.Fatalf("peek after restore = %q, want a", it.ID)
	}
}

// ── persistence ──

func TestPersistentRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.wal")
	pq, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pq.Close()
	mustEnqueueP(t, pq, Item{ID: "a", Weight: 1, Cost: 1})
	mustEnqueueP(t, pq, Item{ID: "b", Weight: 10, Cost: 1})
	it, err := pq.Dequeue()
	if err != nil || it.ID != "b" {
		t.Fatalf("first dequeue = %q, want b", it.ID)
	}
	if err := pq.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: only 'a' remains and ordering is intact.
	pq2, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pq2.Close()
	if pq2.Len() != 1 {
		t.Fatalf("len after reopen = %d, want 1", pq2.Len())
	}
	it, _ = pq2.Peek()
	if it.ID != "a" {
		t.Fatalf("peek after reopen = %q, want a", it.ID)
	}
	it, err = pq2.Dequeue()
	if err != nil || it.ID != "a" {
		t.Fatalf("dequeue after reopen = %q, want a", it.ID)
	}
}

func TestReplayMatchesMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.wal")

	// Memory reference: same ops, no persistence.
	mem := NewQueue()
	applyOps(t, mem)
	want, err := drainIDs(mem)
	if err != nil {
		t.Fatal(err)
	}

	// Persistent run: same ops, close WITHOUT draining so the log holds state.
	pq, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	applyOps(t, pq)
	if err := pq.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen and drain: replay must reproduce the exact memory ordering.
	pq2, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pq2.Close()
	got, err := drainIDs(pq2)
	if err != nil {
		t.Fatal(err)
	}
	if !equalStrings(want, got) {
		t.Fatalf("memory = %v, replay = %v", want, got)
	}
}

func TestTornTailRecovered(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.wal")
	pq, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	mustEnqueueP(t, pq, Item{ID: "a", Weight: 1})
	mustEnqueueP(t, pq, Item{ID: "b", Weight: 1})
	if err := pq.Close(); err != nil {
		t.Fatal(err)
	}

	before, _ := os.Stat(path)
	// Simulate a crash mid-write: header claims 16 payload bytes, only 2 follow.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0x00, 0x00, 0x00, 0x10, 0xde, 0xad}); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	pq2, err := OpenPersistent(path)
	if err != nil {
		t.Fatalf("torn tail must be tolerated: %v", err)
	}
	defer pq2.Close()
	if pq2.Len() != 2 {
		t.Fatalf("len = %d, want 2", pq2.Len())
	}
	if err := pq2.Close(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if after.Size() != before.Size() {
		t.Fatalf("file size after truncate = %d, want %d", after.Size(), before.Size())
	}
}

func TestMidLogCorruptionFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.wal")
	pq, err := OpenPersistent(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pq.Close()
	mustEnqueueP(t, pq, Item{ID: "a", Weight: 1})
	mustEnqueueP(t, pq, Item{ID: "b", Weight: 1})
	mustEnqueueP(t, pq, Item{ID: "c", Weight: 1})
	if err := pq.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data[10] ^= 0xff // flip a byte inside the first record's payload
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenPersistent(path); err == nil {
		t.Fatal("mid-log corruption must be reported")
	}
}

func TestConcurrentPersistentQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.wal")
	pq, err := OpenPersistent(path, WALWithSync(false))
	if err != nil {
		t.Fatal(err)
	}
	defer pq.Close()
	const workers = 8
	const per = 200
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < per; i++ {
				_ = pq.Enqueue(Item{
					ID:     fmt.Sprintf("w%d-%d", w, i),
					Weight: float64((w+i)%10 + 1),
				})
			}
		}(w)
	}
	wg.Wait()
	if pq.Len() != workers*per {
		t.Fatalf("len = %d, want %d", pq.Len(), workers*per)
	}
	count := 0
	for pq.Len() > 0 {
		if _, err := pq.Dequeue(); err != nil {
			t.Fatal(err)
		}
		count++
	}
	if count != workers*per {
		t.Fatalf("dequeued %d, want %d", count, workers*per)
	}
}
