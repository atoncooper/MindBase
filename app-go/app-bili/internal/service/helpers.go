// Shared service helpers: identity resolution interface, small deref/JSON
// utilities, the naive-UTC wire timestamp, and the HTTP error carrier.
package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"app-bili/internal/bili"
)

// Resolver produces ready bilibili clients per uid (implemented by
// bili.CredentialResolver; faked in tests).
type Resolver interface {
	Resolve(ctx context.Context, uid int64) (*bili.Client, int64, error)
}

// HTTPError carries a status code through the service layer.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

// naiveUTC formats times the way the Python backend serialized its
// naive-UTC datetimes (no zone suffix; microseconds only when non-zero).
func naiveUTC(t time.Time) string {
	u := t.UTC()
	if u.Nanosecond() == 0 {
		return u.Format("2006-01-02T15:04:05")
	}
	return u.Format("2006-01-02T15:04:05.") + fmt.Sprintf("%06d", u.Nanosecond()/1000)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func derefBool(p *bool) bool {
	return p != nil && *p
}

func liveStr(p *string) string { return derefStr(p) }

func newTaskID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func jsonUnmarshal(raw string, out any) error { return json.Unmarshal([]byte(raw), out) }

func jsonInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}
