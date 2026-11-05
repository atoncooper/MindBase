package tests

import (
	"testing"

	"app-cloud/internal/service"
)

// Elastic growth rule: double the pool while the pending backlog exceeds
// twice the current size, capped at maxWorkers, and never shrink (growth-only
// — teardown stops the whole pool).
func TestNextWorkerCount(t *testing.T) {
	cases := []struct {
		cur, pending, max, want int
		note                    string
	}{
		{4, 0, 32, 4, "empty queue -> no growth"},
		{4, 8, 32, 4, "pending == 2x -> no growth (strictly greater triggers)"},
		{4, 9, 32, 8, "pending > 2x -> double"},
		{4, 100, 32, 8, "huge backlog still doubles once per tick (gradual)"},
		{30, 100, 32, 32, "capped at maxWorkers"},
		{32, 100, 32, 32, "at cap -> no growth"},
		{16, 0, 32, 16, "idle pool stays at its size"},
	}
	for _, c := range cases {
		if got := service.NextWorkerCount(c.cur, c.pending, c.max); got != c.want {
			t.Fatalf("NextWorkerCount(%d, %d, %d) = %d, want %d (%s)",
				c.cur, c.pending, c.max, got, c.want, c.note)
		}
	}
}
