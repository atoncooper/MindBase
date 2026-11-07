package utils

import (
	"fmt"
	"time"
)

// NaiveUTC formats times the way the Python backend serialized its naive-UTC
// datetimes (no zone suffix; microseconds only when non-zero).
func NaiveUTC(t time.Time) string {
	u := t.UTC()
	if u.Nanosecond() == 0 {
		return u.Format("2006-01-02T15:04:05")
	}
	return u.Format("2006-01-02T15:04:05.") + fmt.Sprintf("%06d", u.Nanosecond()/1000)
}
