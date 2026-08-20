package queue

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

// Benchmarks isolating the three cost layers of persistence:
//   1. json.Marshal of a record (pure CPU)
//   2. WALStore.Append with fsync (sync=true, default — disk-bound)
//   3. WALStore.Append without fsync (sync=false — CPU/syscall-bound)
// plus the full PersistentQueue.Enqueue path and parallel (concurrent)
// variants, since the store serializes all appends under one mutex.

var benchRec = Record{
	Op:      OpEnqueue,
	ItemID:  "task-1234-5678",
	Weight:  3.5,
	Cost:    2,
	FlowKey: "flow-1",
	Payload: []byte(`{"user":"alice","prompt":"explain black holes"}`),
	AtNanos: 1234567890123456789,
}

func BenchmarkJSONMarshalRecord(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := json.Marshal(benchRec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWALAppendSync(b *testing.B) {
	w := newBenchWAL(b, true)
	defer w.Close()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := w.Append(benchRec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWALAppendNoSync(b *testing.B) {
	w := newBenchWAL(b, false)
	defer w.Close()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := w.Append(benchRec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkWALAppendSyncParallel(b *testing.B) {
	w := newBenchWAL(b, true)
	defer w.Close()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if err := w.Append(benchRec); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkWALAppendNoSyncParallel(b *testing.B) {
	w := newBenchWAL(b, false)
	defer w.Close()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if err := w.Append(benchRec); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkWALAppendInterval10ms(b *testing.B) {
	// Time-based delayed flush: appends return without fsync; a background
	// flusher fsyncs every 10ms, amortizing the disk cost over ~110k appends/s.
	path := filepath.Join(b.TempDir(), "bench.wal")
	w, err := NewWALStore(path, WALWithSyncInterval(10*time.Millisecond))
	if err != nil {
		b.Fatal(err)
	}
	defer w.Close()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := w.Append(benchRec); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPersistentQueueEnqueueNoSync(b *testing.B) {
	path := filepath.Join(b.TempDir(), "bench.wal")
	pq, err := OpenPersistent(path, WALWithSync(false))
	if err != nil {
		b.Fatal(err)
	}
	defer pq.Close()
	it := Item{ID: "task-1234-5678", Weight: 3.5, Cost: 2, FlowKey: "flow-1", Payload: []byte(`{"user":"alice"}`)}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := pq.Enqueue(it); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPersistentQueueEnqueueNoSyncParallel(b *testing.B) {
	path := filepath.Join(b.TempDir(), "bench.wal")
	pq, err := OpenPersistent(path, WALWithSync(false))
	if err != nil {
		b.Fatal(err)
	}
	defer pq.Close()
	it := Item{ID: "task-1234-5678", Weight: 3.5, Cost: 2, FlowKey: "flow-1", Payload: []byte(`{"user":"alice"}`)}
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if err := pq.Enqueue(it); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func newBenchWAL(tb testing.TB, sync bool) *WALStore {
	tb.Helper()
	path := filepath.Join(tb.TempDir(), "bench.wal")
	w, err := NewWALStore(path, WALWithSync(sync))
	if err != nil {
		tb.Fatal(err)
	}
	return w
}

// Sanity: the benchmark record must round-trip so the numbers are meaningful.
func TestBenchRecordRoundTrip(t *testing.T) {
	body, err := json.Marshal(benchRec)
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	if err := json.Unmarshal(body, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.ItemID != benchRec.ItemID || rec.Weight != benchRec.Weight || rec.Cost != benchRec.Cost {
		t.Fatalf("round trip mismatch: %+v", rec)
	}
}

// The WALAppend* benchmarks deliberately use a plain file (no replay) so the
// measured cost is Append only; PersistentQueue benchmarks cover the full path.
func TestBenchWALFileCreated(t *testing.T) {
	w := newBenchWAL(t, false)
	defer w.Close()
	if err := w.Append(benchRec); err != nil {
		t.Fatal(err)
	}
}
