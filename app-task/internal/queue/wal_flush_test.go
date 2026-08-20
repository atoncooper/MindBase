package queue

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// flushRec is a small record used by the flush-policy tests.
var flushRec = Record{Op: OpEnqueue, ItemID: "flush-test", Weight: 1, Cost: 1}

// newFlushWAL opens a WALStore with the given options for tests.
func newFlushWAL(t *testing.T, opts ...WALOption) *WALStore {
	t.Helper()
	w, err := NewWALStore(filepath.Join(t.TempDir(), "flush.wal"), opts...)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestSyncIntervalModeConfig(t *testing.T) {
	w := newFlushWAL(t, WALWithSyncInterval(5*time.Second))
	defer w.Close()
	if w.sync {
		t.Fatal("interval mode must disable per-record sync")
	}
	if w.syncEvery != 5*time.Second {
		t.Fatalf("syncEvery = %v, want 5s", w.syncEvery)
	}
}

func TestMaxUnsyncedForcesInlineSync(t *testing.T) {
	w := newFlushWAL(t, WALWithMaxUnsynced(2))
	defer w.Close()
	if w.sync {
		t.Fatal("count mode must disable per-record sync")
	}
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	if w.unsynced != 1 {
		t.Fatalf("unsynced = %d, want 1", w.unsynced)
	}
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	if w.unsynced != 0 {
		t.Fatalf("unsynced = %d, want 0 (inline fsync at cap)", w.unsynced)
	}
}

func TestIntervalFlusherSyncesWhenDirty(t *testing.T) {
	w := newFlushWAL(t, WALWithSyncInterval(20*time.Millisecond))
	defer w.Close()
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	// The background flusher must observe the dirty flag and clear it.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		w.mu.Lock()
		u := w.unsynced
		w.mu.Unlock()
		if u == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("background flush did not clear unsynced (still %d)", w.unsynced)
}

func TestIntervalFlusherIdlesWhenClean(t *testing.T) {
	// No appends: several ticks must not error and Close must be prompt.
	w := newFlushWAL(t, WALWithSyncInterval(10*time.Millisecond))
	time.Sleep(50 * time.Millisecond)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.SyncError(); err != nil {
		t.Fatal(err)
	}
}

func TestCloseFlushesPendingRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flush.wal")
	w, err := NewWALStore(path, WALWithSyncInterval(time.Hour)) // flusher never fires
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	if w.unsynced != 2 {
		t.Fatalf("precondition: unsynced = %d, want 2", w.unsynced)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if w.unsynced != 0 {
		t.Fatalf("Close must flush pending records (unsynced = %d)", w.unsynced)
	}
	// Reopen: both records are intact.
	w2, err := NewWALStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer w2.Close()
	n := 0
	if err := w2.Replay(func(Record) error { n++; return nil }); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("replayed %d records, want 2", n)
	}
}

func TestCloseIdempotent(t *testing.T) {
	w := newFlushWAL(t, WALWithSyncInterval(time.Millisecond))
	if err := w.Append(flushRec); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close must be a no-op: %v", err)
	}
}

func TestConcurrentAppendAndClose(t *testing.T) {
	w := newFlushWAL(t, WALWithSyncInterval(5*time.Millisecond), WALWithMaxUnsynced(50))
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = w.Append(flushRec)
				}
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	if err := w.Close(); err != nil {
		t.Fatalf("Close must not deadlock/fail under concurrent appends: %v", err)
	}
	close(stop)
	wg.Wait()
}
