package utils

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// NewTaskID returns a random hex task id (falls back to the clock on entropy
// failure). Used by the bili ASR/build task rows.
func NewTaskID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
