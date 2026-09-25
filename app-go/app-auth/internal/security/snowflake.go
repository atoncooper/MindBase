package security

import (
	"fmt"
	"sync"
	"time"
)

// Snowflake generates 64-bit unique uids with the SAME bit layout as the
// Python backend (app/utils/snowflake.py):
//
//	[1 reserved] [41 ms timestamp] [10 worker] [12 sequence]
//
// The worker id MUST differ from the Python backend's (default 1) so the two
// processes never mint the same uid. Config: worker_id (default 2).
type Snowflake struct {
	mu       sync.Mutex
	workerID int64
	lastMS   int64
	seq      int64
}

const (
	epochMS        = int64(1735689600000) // 2025-01-01T00:00:00Z, same as Python
	workerBits     = 10
	sequenceBits   = 12
	maxSequence    = (1 << sequenceBits) - 1
	timestampShift = workerBits + sequenceBits
	workerShift    = sequenceBits
)

func NewSnowflake(workerID int) (*Snowflake, error) {
	if workerID < 0 || workerID >= 1<<workerBits {
		return nil, fmt.Errorf("worker_id must be 0..%d, got %d", (1<<workerBits)-1, workerID)
	}
	return &Snowflake{workerID: int64(workerID), lastMS: -1}, nil
}

// Next returns the next unique id. Blocks (busy-wait bounded to the next ms)
// when the sequence space for the current millisecond is exhausted.
func (s *Snowflake) Next() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	if now == s.lastMS {
		s.seq = (s.seq + 1) & maxSequence
		if s.seq == 0 {
			for now <= s.lastMS {
				now = time.Now().UnixMilli()
			}
		}
	} else {
		s.seq = 0
	}
	s.lastMS = now

	ts := (now - epochMS) & 0x1FFFFFFFFFF // 41 bits
	return ts<<timestampShift | s.workerID<<workerShift | s.seq
}
