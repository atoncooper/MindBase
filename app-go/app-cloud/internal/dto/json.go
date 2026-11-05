package dto

// JSON decoding helpers shared by the presence-tracking request DTOs.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

func isJSONNull(v json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(v), []byte("null"))
}

// parseJSONInt64 accepts the numeric or numeric-string forms clients send for
// ids (parity with the legacy id coercion).
func parseJSONInt64(v json.RawMessage) (int64, bool) {
	var anyVal any
	if err := json.Unmarshal(v, &anyVal); err != nil {
		return 0, false
	}
	switch n := anyVal.(type) {
	case float64:
		return int64(n), true
	case string:
		out, err := strconv.ParseInt(strings.TrimSpace(n), 10, 64)
		if err != nil {
			return 0, false
		}
		return out, true
	default:
		return 0, false
	}
}
