package bench

// DB-path benchmarks: single-row claim, release round trip, reclaim sweep,
// candidate scans, and the audit-trail insert. All SQLite in-memory — see the
// package doc for the honesty notes.

import (
	"fmt"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"
)

// seedStaleClaims inserts n rows already in dispatching with an old
// claimed_at (candidates for the reclaim sweep).
func seedStaleClaims(tb testing.TB, n int) {
	tb.Helper()
	old := time.Now().UTC().Add(-time.Hour)
	tasks := make([]model.Task, n)
	for i := range tasks {
		tasks[i] = model.Task{
			TaskID:      fmt.Sprintf("bench-stale-%d", i),
			TaskType:    "http",
			Status:      repo.StatusDispatching,
			Owner:       "dead-node",
			ClaimedAt:   &old,
			TriggerTime: old,
		}
	}
	if err := db.DB.CreateInBatches(&tasks, 500).Error; err != nil {
		tb.Fatalf("seed stale claims: %v", err)
	}
}

// BenchmarkClaimSingleRoundTrip measures the single-task fenced claim + give
// back round trip (the per-task unit of the saturation path).
func BenchmarkClaimSingleRoundTrip(b *testing.B) {
	setupDB(b)
	seedDueTasks(b, 2000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		id := fmt.Sprintf("bench-task-%d", i%2000)
		token, ok, err := repo.ClaimTask(id, "bench", time.Now().UTC())
		if err != nil || !ok {
			b.Fatalf("claim = %v %v", ok, err)
		}
		if _, err := repo.ReleaseClaim(id, token); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkReleaseRoundTrip measures claim(batch=1) + ReleaseClaim via the
// batch API — the saturation give-back path end to end.
func BenchmarkReleaseRoundTrip(b *testing.B) {
	setupDB(b)
	seedDueTasks(b, 2000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		claimed, err := repo.ClaimTasksBatch(1, "bench", time.Now().UTC())
		if err != nil {
			b.Fatal(err)
		}
		if len(claimed) != 1 {
			b.Fatalf("claimed %d, want 1", len(claimed))
		}
		if _, err := repo.ReleaseClaim(claimed[0].TaskID, claimed[0].ClaimToken); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkReclaimSweep measures the stale-claim reclaim sweep over 1000
// rows: re-stale inside the timer (one bulk UPDATE) + the sweep UPDATE —
// i.e. the full sweep cost at this scale.
func BenchmarkReclaimSweep(b *testing.B) {
	setupDB(b)
	seedStaleClaims(b, 1000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if n, err := repo.ReclaimDispatching(time.Now().UTC().Add(-time.Minute)); err != nil {
			b.Fatal(err)
		} else if n != 1000 {
			b.Fatalf("reclaimed %d, want 1000", n)
		}
		b.StopTimer()
		// re-stale for the next iteration
		db.DB.Model(&model.Task{}).
			Where("status = ? AND owner = ?", "pending", "dead-node").
			Updates(map[string]any{
				"status":     repo.StatusDispatching,
				"claimed_at": time.Now().UTC().Add(-time.Hour),
				"updated_at": time.Now().UTC().Add(-time.Hour),
			})
		b.StartTimer()
	}
}

// BenchmarkCandidatesScan measures the due-candidate SELECT on a 10k backlog
// (the read half of the claim transaction).
func BenchmarkCandidatesScan(b *testing.B) {
	setupDB(b)
	seedDueTasks(b, 10000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := repo.ListDuePending(50); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkTaskLogInsert measures one audit-trail row insert (every executed
// task writes exactly one).
func BenchmarkTaskLogInsert(b *testing.B) {
	setupDB(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := repo.CreateTaskLog(&model.TaskLog{
			LogID:     fmt.Sprintf("bench-log-%d", i),
			TaskID:    fmt.Sprintf("bench-task-%d", i),
			TriggerAt: time.Now().UTC(),
			Executor:  "http://bench-gate",
			Request:   `{"k":"v"}`,
			Status:    "success",
		}); err != nil {
			b.Fatal(err)
		}
	}
}
