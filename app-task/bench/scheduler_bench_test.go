// Package bench is app-task's self-contained benchmark + invariant suite
// (black-box: exported APIs only; independent of internal/ visibility).
//
// Layout:
//
//   - scheduler_bench_test.go  claim batch / parallel contention /
//     claim+finalize / email claim / end-to-end drain benchmarks
//   - db_bench_test.go         single-row claim & release round trips,
//     reclaim sweep, candidate scan, task_log insert
//   - cluster_bench_test.go    node heartbeat, join pre-registration
//   - concurrency_test.go      concurrency & consistency invariant TESTS
//     (run with `go test -run TestConcurrent -v ./bench/`)
//
// Run the benchmarks (from app-task/):
//
//	go test -bench . -benchmem -run '^$' ./bench/
//
// # Honesty notes (read before drawing conclusions)
//
//   - All benchmarks run against in-memory SQLite (glebarez), NOT MySQL.
//     Absolute numbers are therefore NOT production numbers — use them to
//     compare code paths, catch regressions, and sanity-check scaling shape
//     (e.g. parallel claim contention). On MySQL the claim transaction takes
//     the SKIP LOCKED path and real network round-trips dominate.
//   - The scheduler drain benchmark is black-box: it seeds due tasks, starts a
//     real scheduler (1ms ticks), and measures time to drain. task_log rows
//     written during the run are part of the measured cost (production writes
//     them too).
//   - Setup/seeding is excluded from timers via StopTimer/StartTimer; the
//     measured region is explicitly marked in each benchmark.
//
// Run (from app-task/):
//
//	go test -bench . -benchmem -run '^$' ./bench/
package bench

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/internal/service"

	"github.com/glebarez/sqlite"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupDB opens an in-memory SQLite, installs it as the process-wide DB and
// migrates the full app-task schema.
func setupDB(tb testing.TB) {
	tb.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		tb.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1) // SQLite: a second conn would hit "database is locked"
	if err := gdb.AutoMigrate(
		&model.Task{}, &model.TaskLog{}, &model.EmailMessage{},
		&model.Script{}, &model.ScriptLog{}, &model.ScriptRun{},
		&model.APIKey{}, &model.Secret{}, &model.WebUIUser{}, &model.ClusterNode{},
	); err != nil {
		tb.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
	tb.Cleanup(func() { db.DB = nil })
}

// seedDueTasks inserts n due pending tasks and returns nothing (ids are
// deterministic: bench-task-<i>).
func seedDueTasks(tb testing.TB, n int) {
	tb.Helper()
	past := time.Now().UTC().Add(-time.Minute)
	tasks := make([]model.Task, n)
	for i := range tasks {
		tasks[i] = model.Task{
			TaskID:      fmt.Sprintf("bench-task-%d", i),
			TaskType:    "http",
			Payload:     datatypes.JSON(`{}`),
			ExecutorURL: "http://bench-gate",
			Status:      "pending",
			TriggerTime: past,
			MaxRetry:    0,
			Weight:      1,
		}
	}
	if err := db.DB.CreateInBatches(&tasks, 500).Error; err != nil {
		tb.Fatalf("seed tasks: %v", err)
	}
}

// resetClaims returns every claimed (dispatching) task to pending, EXCLUDED
// from the measured region by the caller's StopTimer/StartTimer bracket.
func resetClaims(tb testing.TB) {
	tb.Helper()
	if err := db.DB.Model(&model.Task{}).
		Where("status = ?", repo.StatusDispatching).
		Updates(map[string]any{
			"status":      "pending",
			"owner":       "",
			"claimed_at":  nil,
			"claim_token": "",
			"updated_at":  time.Now().UTC(),
		}).Error; err != nil {
		tb.Fatalf("reset claims: %v", err)
	}
}

// noopRegistry returns an executor registry whose handler is a no-op — the
// benchmark measures the claim/dispatch/finalize machinery, not executors.
func noopRegistry() *executor.Registry {
	reg := executor.NewRegistry()
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		return nil
	}))
	return reg
}

// ── 1. 批量认领事务（DB 热路径）─────────────────────────────────────

// BenchmarkClaimTasksBatch measures one claim transaction (SELECT candidates +
// conditional flip to dispatching) against backlogs of different sizes, with
// the claimed rows reset to pending outside the timer each iteration.
func BenchmarkClaimTasksBatch(b *testing.B) {
	for _, backlog := range []int{10, 1000, 10000} {
		b.Run(fmt.Sprintf("backlog=%d", backlog), func(b *testing.B) {
			setupDB(b)
			seedDueTasks(b, backlog)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := repo.ClaimTasksBatch(50, "bench", time.Now().UTC()); err != nil {
					b.Fatal(err)
				}
				b.StopTimer()
				resetClaims(b)
				b.StartTimer()
			}
		})
	}
}

// ── 2. 并发认领竞争（G 个"实例"同时抢）───────────────────────────────

// BenchmarkClaimParallel measures contended claim+release round trips from G
// concurrent claimants (simulating G cluster instances ticking at once). The
// release IS part of the measured cost — it documents the claim+give-back
// round trip that saturation produces.
func BenchmarkClaimParallel(b *testing.B) {
	for _, claimants := range []int{1, 4, 8} {
		b.Run(fmt.Sprintf("claimants=%d", claimants), func(b *testing.B) {
			setupDB(b)
			seedDueTasks(b, 5000)
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					if _, err := repo.ClaimTasksBatch(16, "bench", time.Now().UTC()); err != nil {
						b.Error(err)
						return
					}
					// give the claimed rows back so work never runs out
					if err := db.DB.Model(&model.Task{}).
						Where("status = ?", repo.StatusDispatching).
						Updates(map[string]any{
							"status":      "pending",
							"owner":       "",
							"claimed_at":  nil,
							"claim_token": "",
							"updated_at":  time.Now().UTC(),
						}).Error; err != nil {
						b.Error(err)
						return
					}
				}
			})
		})
	}
}

// ── 3. 认领 + fencing finalize（完整状态转换往返）────────────────────

// BenchmarkClaimFinalize measures the full claim→fenced-finalize round trip
// per task (the exact pair every executed task performs).
func BenchmarkClaimFinalize(b *testing.B) {
	setupDB(b)
	seedDueTasks(b, 2000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		claimed, err := repo.ClaimTasksBatch(1, "bench", time.Now().UTC())
		if err != nil {
			b.Fatal(err)
		}
		if len(claimed) != 1 {
			b.Fatalf("claimed %d rows, want 1", len(claimed))
		}
		if ok, err := repo.FinalizeClaim(claimed[0].TaskID, claimed[0].ClaimToken,
			"completed", map[string]any{"last_result": "ok"}); err != nil || !ok {
			b.Fatalf("finalize = %v %v", ok, err)
		}
		b.StopTimer()
		resetClaims(b)
		b.StartTimer()
	}
}

// ── 4. 邮件认领 + 栅栏标记（sending 生命周期）────────────────────────

// BenchmarkClaimEmail measures the per-email claim→sent-mark round trip.
func BenchmarkClaimEmail(b *testing.B) {
	setupDB(b)
	const pool = 2000
	emails := make([]model.EmailMessage, pool)
	for i := range emails {
		emails[i] = model.EmailMessage{
			EmailID:  fmt.Sprintf("bench-email-%d", i),
			To:       datatypes.JSON(`["a@x.com"]`),
			Subject:  "bench",
			BodyHTML: "<p>x</p>",
			Status:   "pending",
		}
	}
	if err := db.DB.CreateInBatches(&emails, 500).Error; err != nil {
		b.Fatalf("seed emails: %v", err)
	}
	var cursor atomic.Int64
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		idx := int(cursor.Add(1)-1) % pool
		id := emails[idx].EmailID
		token, ok, err := repo.ClaimEmail(id, time.Now().UTC())
		if err != nil || !ok {
			b.Fatalf("claim = %v %v", ok, err)
		}
		if err := repo.MarkEmailSent(id, token); err != nil {
			b.Fatal(err)
		}
		b.StopTimer()
		// release back to pending for the next wrap-around
		db.DB.Model(&model.EmailMessage{}).Where("email_id = ?", id).
			Updates(map[string]any{"status": "pending", "claim_token": "", "updated_at": time.Now().UTC()})
		b.StartTimer()
	}
}

// ── 5. 黑盒整管道：调度器排空 N 个任务的端到端吞吐 ────────────────────

// BenchmarkSchedulerDrain measures the END-TO-END drain throughput: seed N due
// tasks, start a real scheduler (1ms ticks, parallel dispatch), wait until all
// are completed. This is the number to quote when asked "how fast does a node
// chew through a backlog". task_log writes are included (production cost).
//
// The custom metric "tasks/s" is the meaningful output; ns/op includes
// seeding/cleanup and should be ignored.
func BenchmarkSchedulerDrain(b *testing.B) {
	const batch = 1000
	for _, workers := range []int{8, 16, 32} {
		b.Run(fmt.Sprintf("workers=%d", workers), func(b *testing.B) {
			setupDB(b)
			reg := noopRegistry()
			var elapsed time.Duration
			var doneTotal int64
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				seedDueTasks(b, batch)
				s := service.NewScheduler(reg, service.SchedulerOptions{
					Interval:  time.Millisecond,
					Workers:   workers,
					BatchSize: workers,
					Owner:     "bench",
				})
				s.Start()
				b.StartTimer()

				start := time.Now()
				for {
					var cnt int64
					db.DB.Model(&model.Task{}).Where("status = ?", "completed").Count(&cnt)
					if int(cnt) >= batch {
						break
					}
					time.Sleep(200 * time.Microsecond)
				}
				elapsed += time.Since(start)
				doneTotal += batch

				b.StopTimer()
				s.Stop()
				// clear completed tasks so the next iteration counts cleanly
				db.DB.Where("status = ?", "completed").Delete(&model.Task{})
			}
			perSec := float64(doneTotal) / elapsed.Seconds()
			b.ReportMetric(0, "ns/op")
			b.ReportMetric(perSec, "tasks/s")
		})
	}
}
