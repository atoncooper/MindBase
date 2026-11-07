// Shared service helpers: identity resolution interface, small deref/JSON
// utilities, the naive-UTC wire timestamp, and the HTTP error carrier.
package service

import (
	"context"
	"encoding/json"

	"app-user/internal/bili/bili"
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
