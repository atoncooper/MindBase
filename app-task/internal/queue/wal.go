package queue

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
	"time"
)

// OpType identifies a write-ahead log operation.
type OpType uint8

const (
	// OpEnqueue records an item being enqueued.
	OpEnqueue OpType = 1
	// OpDequeue records an item being dequeued (removed).
	OpDequeue OpType = 2
)

// Record is one durable operation written to the log. It carries everything
// needed to replay the operation exactly: finish times are recomputed by the
// replay (the algorithm is deterministic in the op sequence), so F and V are
// not stored.
type Record struct {
	Op      OpType  `json:"op"`
	ItemID  string  `json:"item_id,omitempty"`
	Weight  float64 `json:"weight,omitempty"`
	Cost    float64 `json:"cost,omitempty"`
	FlowKey string  `json:"flow_key,omitempty"`
	Payload []byte  `json:"payload,omitempty"`
	AtNanos int64   `json:"at_nanos,omitempty"` // audit timestamp only
}

// Store is the durable backend of a PersistentQueue. WALStore is the bundled
// append-only-file implementation; alternative backends (e.g. MySQL rows) can
// implement the same interface and be plugged in via NewPersistentQueue.
type Store interface {
	// Append durably records one operation (enqueue or dequeue).
	Append(rec Record) error
	// Replay invokes fn for every record, oldest first. A torn tail produced
	// by a crash is tolerated and truncated; corruption in the middle of the
	// log is reported as an error.
	Replay(fn func(Record) error) error
	// Close releases the underlying resource.
	Close() error
}

// Frame layout: [4-byte big-endian payload length][4-byte crc32][payload].
const (
	walHeaderSize = 8
	maxRecordSize = 8 << 20 // 8 MiB sanity bound
)

// WALOptions configure a WALStore flush policy.
//
// Three policies, freely combinable (interval + count can be set together;
// whichever bound is hit first triggers the flush):
//
//   - per-record fsync  : WALWithSync(true)             (default)
//   - time-based        : WALWithSyncInterval(3s|5s|…)  (background flusher)
//   - count-based       : WALWithMaxUnsynced(1000|…)    (inline flush at cap)
//
// Any delayed-flush option (interval or count) replaces per-record fsync:
// appends return once the record reaches the OS page cache, and the fsync is
// amortized. A process crash loses nothing (page cache survives); a power
// failure may lose at most the records since the last flush. Graceful Close
// always flushes everything that is still pending.
type WALOptions struct {
	sync        bool
	syncEvery   time.Duration
	maxUnsynced int
}

// WALOption mutates WALOptions.
type WALOption func(*WALOptions)

// WALWithSync controls whether every Append calls fsync before returning.
// True (the default) gives durable semantics; false trades durability for
// throughput (a crash may lose the most recent appends).
func WALWithSync(enabled bool) WALOption {
	return func(o *WALOptions) { o.sync = enabled }
}

// WALWithSyncInterval enables time-based delayed flushing: appends are not
// fsynced individually; a background goroutine fsyncs every d (e.g. 3s, 5s).
// A power failure loses at most the appends of the last interval. d <= 0 is
// a no-op. Disables per-record fsync.
func WALWithSyncInterval(d time.Duration) WALOption {
	return func(o *WALOptions) {
		if d > 0 {
			o.syncEvery = d
			o.sync = false
		}
	}
}

// WALWithMaxUnsynced enables count-based delayed flushing: after n appends
// without a flush, an inline fsync is forced (e.g. 1000). n <= 0 is a no-op.
// Disables per-record fsync. Combine with WALWithSyncInterval for the
// whichever-comes-first policy.
func WALWithMaxUnsynced(n int) WALOption {
	return func(o *WALOptions) {
		if n > 0 {
			o.maxUnsynced = n
			o.sync = false
		}
	}
}

// WALStore is an append-only, CRC-protected write-ahead log on a single file.
// It is single-process by design: one queue owns one WAL file.
type WALStore struct {
	path        string
	f           *os.File
	mu          sync.Mutex
	sync        bool
	syncEvery   time.Duration
	maxUnsynced int
	unsynced    int // records written since the last fsync
	lastSyncErr error
	closed      bool
	stopCh      chan struct{}
	wg          sync.WaitGroup
}

// NewWALStore opens (creating if needed) an append-only log file.
func NewWALStore(path string, opts ...WALOption) (*WALStore, error) {
	o := &WALOptions{sync: true}
	for _, opt := range opts {
		opt(o)
	}
	if o.syncEvery > 0 {
		o.sync = false // interval mode takes precedence regardless of option order
	}
	// NOTE: no O_APPEND. On Windows a handle opened with O_APPEND lacks
	// FILE_WRITE_DATA and cannot be truncated (SetEndOfFile fails with
	// Access denied); we seek to the end before every write instead.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("queue: open wal: %w", err)
	}
	w := &WALStore{
		path:        path,
		f:           f,
		sync:        o.sync,
		syncEvery:   o.syncEvery,
		maxUnsynced: o.maxUnsynced,
		stopCh:      make(chan struct{}),
	}
	if w.syncEvery > 0 {
		w.startFlusher()
	}
	return w, nil
}

// Append writes one record and applies the configured flush policy.
func (w *WALStore) Append(rec Record) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("queue: wal is closed")
	}
	body, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("queue: encode record: %w", err)
	}
	if len(body) > maxRecordSize {
		return fmt.Errorf("queue: record too large (%d bytes)", len(body))
	}
	frame := make([]byte, walHeaderSize+len(body))
	binary.BigEndian.PutUint32(frame[0:4], uint32(len(body)))
	binary.BigEndian.PutUint32(frame[4:8], crc32.ChecksumIEEE(body))
	copy(frame[8:], body)
	// All access is serialized by w.mu, so seeking to the end here is atomic
	// within the process and keeps the write append-only.
	if _, err := w.f.Seek(0, io.SeekEnd); err != nil {
		return fmt.Errorf("queue: wal seek: %w", err)
	}
	if _, err := w.f.Write(frame); err != nil {
		return fmt.Errorf("queue: wal write: %w", err)
	}
	if w.sync {
		// Policy 1: per-record fsync — Append returns only once durable.
		if err := w.f.Sync(); err != nil {
			return fmt.Errorf("queue: wal sync: %w", err)
		}
		return nil
	}
	// Delayed-flush mode: count unsynced records; force an inline fsync when
	// the configured count cap is hit (the background flusher handles the
	// time cap, if any).
	w.unsynced++
	if w.maxUnsynced > 0 && w.unsynced >= w.maxUnsynced {
		if err := w.f.Sync(); err != nil {
			return fmt.Errorf("queue: wal sync: %w", err)
		}
		w.unsynced = 0
	}
	return nil
}

// startFlusher launches the background goroutine that implements the
// time-based flush policy (WALWithSyncInterval).
func (w *WALStore) startFlusher() {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		t := time.NewTicker(w.syncEvery)
		defer t.Stop()
		for {
			select {
			case <-w.stopCh:
				return
			case <-t.C:
				w.flushIfDirty()
			}
		}
	}()
}

// flushIfDirty fsyncs once if any records are unsynced. Called by the
// background flusher on each tick; a no-op when clean, so an idle queue
// never pays for pointless fsyncs.
func (w *WALStore) flushIfDirty() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.unsynced == 0 {
		return
	}
	if err := w.f.Sync(); err != nil {
		w.lastSyncErr = fmt.Errorf("queue: wal background sync: %w", err)
		return
	}
	w.unsynced = 0
	w.lastSyncErr = nil
}

// SyncError returns the last error from a background (time-based) flush, if
// any. A failed background sync is retried on the next tick; this accessor
// lets callers observe a persistently failing flush. Cleared on success.
func (w *WALStore) SyncError() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.lastSyncErr
}

// Replay reads the whole log and invokes fn for each valid record in order.
// If the log ends with a torn record (partial header/payload, or a bad CRC on
// the last frame) — the normal outcome of a crash mid-write — the file is
// truncated to the last good offset and replay ends cleanly. Any corruption
// before the tail is fatal (it would silently drop committed operations).
func (w *WALStore) Replay(fn func(Record) error) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("queue: wal is closed")
	}
	data, err := os.ReadFile(w.path)
	if err != nil {
		return fmt.Errorf("queue: wal read: %w", err)
	}
	off := 0
	lastGood := 0
	for off < len(data) {
		if len(data)-off < walHeaderSize {
			// torn header at tail
			return w.truncateTo(off)
		}
		size := int(binary.BigEndian.Uint32(data[off : off+4]))
		crc := binary.BigEndian.Uint32(data[off+4 : off+8])
		if size > maxRecordSize {
			return fmt.Errorf("queue: wal corrupt record size %d at offset %d", size, off)
		}
		bodyStart := off + walHeaderSize
		bodyEnd := bodyStart + size
		if bodyEnd > len(data) {
			// torn payload at tail
			return w.truncateTo(lastGood)
		}
		if crc32.ChecksumIEEE(data[bodyStart:bodyEnd]) != crc {
			if bodyEnd == len(data) {
				return w.truncateTo(lastGood)
			}
			return fmt.Errorf("queue: wal crc mismatch at offset %d", off)
		}
		var rec Record
		if err := json.Unmarshal(data[bodyStart:bodyEnd], &rec); err != nil {
			return fmt.Errorf("queue: wal decode at offset %d: %w", off, err)
		}
		if err := fn(rec); err != nil {
			return err
		}
		lastGood = bodyEnd
		off = bodyEnd
	}
	return nil
}

// truncateTo drops everything at or after off (torn-tail cleanup).
func (w *WALStore) truncateTo(off int) error {
	if err := w.f.Truncate(int64(off)); err != nil {
		return fmt.Errorf("queue: wal truncate: %w", err)
	}
	// The next Append seeks to the end (now off), so no explicit seek needed.
	return nil
}

// Close stops the background flusher, flushes anything the delayed-flush
// policy left pending, and closes the file. Idempotent.
func (w *WALStore) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	close(w.stopCh)
	var syncErr error
	if w.unsynced > 0 {
		// Graceful shutdown: do not lose the records of the last flush window.
		if err := w.f.Sync(); err != nil {
			syncErr = fmt.Errorf("queue: wal final sync: %w", err)
		}
		w.unsynced = 0
	}
	closeErr := w.f.Close()
	w.mu.Unlock()

	// The flusher exits via stopCh and only touches the file under w.mu, so it
	// can never run concurrently with the close above; wait for it to unwind.
	w.wg.Wait()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
