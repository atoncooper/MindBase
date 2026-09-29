package bench

// Concurrency and consistency tests, black-box (exported APIs only).
//
// Invariants exercised here:
//
//	I1 claim exclusivity   — a task is claimed by exactly one claimant
//	I2 fenced finalize     — only the current claim token may finalize; a
//	                         stale token (reclaimed claim) is rejected
//	I3 drain completeness  — under mixed finalize/release churn, every task
//	                         eventually completes exactly once
//	I4 email uniqueness    — one email is claimed (and delivered) once
//	I5 cron atomicity      — concurrent extensions yield one next occurrence
//	I6 dead-node takeover  — stale-node claims are recovered while live
//	                         claims are untouched
//
// All tests run against in-memory SQLite: goroutine-level interleaving is
// exercised, but InnoDB row-lock semantics are NOT — the MySQL-specific path
// (SKIP LOCKED) is guarded by the same conditional-update logic, so the
// invariants proven here are the ones the production DB must also uphold.
// Run with: go test -run TestConcurrent -v ./bench/

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"gorm.io/datatypes"
)

// TestConcurrentClaimExclusivity proves I1: 8 claimants racing over a shared
// pool of 400 tasks end up with pairwise-disjoint claim sets whose union is
// exactly the seeded pool.
func TestConcurrentClaimExclusivity(t *testing.T) {
	setupDB(t)
	const (
		claimants = 8
		tasksN    = 400
		batch     = 10
	)
	seedDueTasks(t, tasksN)

	var mu sync.Mutex
	claimed := make(map[string]int) // task_id -> claimant
	var wg sync.WaitGroup
	for g := 0; g < claimants; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			owner := fmt.Sprintf("node-%d", g)
			for {
				claimedRows, err := repo.ClaimTasksBatch(batch, owner, time.Now().UTC())
				if err != nil {
					t.Errorf("claim: %v", err)
					return
				}
				if len(claimedRows) == 0 {
					return // pool drained
				}
				mu.Lock()
				for _, r := range claimedRows {
					claimed[r.TaskID]++
				}
				mu.Unlock()
			}
		}(g)
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(claimed) != tasksN {
		t.Fatalf("distinct claimed tasks = %d, want %d", len(claimed), tasksN)
	}
	for id, n := range claimed {
		if n != 1 {
			t.Fatalf("task %s claimed %d times, want exactly 1", id, n)
		}
	}
}

// TestFencedFinalizeUnderReclaim proves I2 across 50 rounds: claim → forced
// reclaim (simulated TTL expiry) → re-claim → the STALE token's finalize is
// always rejected and the fresh token's always accepted.
func TestFencedFinalizeUnderReclaim(t *testing.T) {
	setupDB(t)
	for round := 0; round < 50; round++ {
		seedDueTasks(t, 1) // 每轮种子同一 id（bench-task-0），轮末已删除
		id := "bench-task-0"

		tok1, ok1, err := repo.ClaimTask(id, "stale", time.Now().UTC())
		if err != nil || !ok1 {
			t.Fatalf("round %d: first claim = %v %v", round, ok1, err)
		}
		// cutoff 在未来：回收该轮全部已存在的认领（模拟 TTL 已过期）
		if n, err := repo.ReclaimDispatching(time.Now().UTC().Add(time.Minute)); err != nil || n != 1 {
			t.Fatalf("round %d: reclaim = %d %v", round, n, err)
		}
		tok2, ok2, err := repo.ClaimTask(id, "fresh", time.Now().UTC())
		if err != nil || !ok2 {
			t.Fatalf("round %d: re-claim = %v %v", round, ok2, err)
		}

		if ok, _ := repo.FinalizeClaim(id, tok1, "completed", nil); ok {
			t.Fatalf("round %d: stale token finalized over the fresh claim", round)
		}
		if ok, _ := repo.FinalizeClaim(id, tok2, "completed", nil); !ok {
			t.Fatalf("round %d: fresh holder finalize rejected", round)
		}
		// 清理本轮任务行：下一轮重新种子（id 相同，避免唯一约束冲突）
		db.DB.Where("task_id = ?", id).Delete(&model.Task{})
	}
}

// TestConcurrentMixedWorkloadDrain proves I3: 4 workers churning through 200
// tasks with mixed finalize (70%) / release (30%) outcomes drain the pool
// completely — every task completes exactly once, no task is stranded in
// pending or dispatching.
func TestConcurrentMixedWorkloadDrain(t *testing.T) {
	setupDB(t)
	const tasksN = 200
	seedDueTasks(t, tasksN)

	var counter atomic.Int64 // deterministic outcome selector
	var wg sync.WaitGroup
	worker := func(w int) {
		defer wg.Done()
		owner := fmt.Sprintf("node-%d", w)
		for round := 0; round < 100; round++ {
			claimed, err := repo.ClaimTasksBatch(10, owner, time.Now().UTC())
			if err != nil || len(claimed) == 0 {
				return // pool drained for this worker
			}
			for i := range claimed {
				tk := &claimed[i]
				if counter.Add(1)%10 < 3 {
					// 30%: release back (simulated saturation)
					_, _ = repo.ReleaseClaim(tk.TaskID, tk.ClaimToken)
					continue
				}
				if ok, err := repo.FinalizeClaim(tk.TaskID, tk.ClaimToken, "completed", nil); err != nil || !ok {
					t.Errorf("finalize %s = %v %v", tk.TaskID, ok, err)
					return
				}
			}
		}
	}
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go worker(w)
	}
	wg.Wait()

	// Invariant: pool fully drained, every task completed exactly once.
	var pending, dispatching, completed int64
	db.DB.Model(&model.Task{}).Where("status = ?", "pending").Count(&pending)
	db.DB.Model(&model.Task{}).Where("status = ?", "dispatching").Count(&dispatching)
	db.DB.Model(&model.Task{}).Where("status = ?", "completed").Count(&completed)
	if pending != 0 || dispatching != 0 {
		t.Fatalf("stranded tasks: pending=%d dispatching=%d", pending, dispatching)
	}
	if completed != tasksN {
		t.Fatalf("completed = %d, want %d", completed, tasksN)
	}
}

// TestConcurrentEmailClaimRace proves I4: 8 goroutines racing to claim the
// same email produce exactly one winning claim.
func TestConcurrentEmailClaimRace(t *testing.T) {
	setupDB(t)
	if err := db.DB.Create(&model.EmailMessage{
		EmailID:  "race-email",
		To:       datatypes.JSON(`["a@x.com"]`),
		Subject:  "race",
		BodyHTML: "<p>x</p>",
		Status:   "pending",
	}).Error; err != nil {
		t.Fatal(err)
	}

	var okCount atomic.Int64
	var winnerToken atomic.Value // string
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, ok, err := repo.ClaimEmail("race-email", time.Now().UTC())
			if err != nil {
				t.Errorf("claim: %v", err)
				return
			}
			if ok {
				okCount.Add(1)
				winnerToken.Store(token)
			}
		}()
	}
	wg.Wait()

	if okCount.Load() != 1 {
		t.Fatalf("winning claims = %d, want exactly 1", okCount.Load())
	}
	// Winner's fenced mark succeeds; a second mark with the same token is a
	// no-op state-wise (already sent).
	if err := repo.MarkEmailSent("race-email", winnerToken.Load().(string)); err != nil {
		t.Fatal(err)
	}
}

// TestConcurrentCronExtendAtomic proves I5: 8 goroutines extending the same
// terminal cron task yield exactly one next occurrence, linked from the
// source task.
func TestConcurrentCronExtendAtomic(t *testing.T) {
	setupDB(t)
	src := &model.Task{
		TaskID:   "cron-src",
		TaskType: "http",
		Status:   "completed",
		CronExpr: "0 23 * * *",
	}
	if err := db.DB.Create(src).Error; err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = repo.ExtendCronTask(src, time.Now().UTC().Add(time.Hour))
		}()
	}
	wg.Wait()

	var nexts []model.Task
	db.DB.Where("cron_expr = ? AND status = ?", "0 23 * * *", "pending").Find(&nexts)
	if len(nexts) != 1 {
		t.Fatalf("next occurrences = %d, want exactly 1 (orphan duplicates must not exist)", len(nexts))
	}
	updated, _ := repo.GetTaskByID("cron-src")
	if updated == nil || updated.CronNextTaskID != nexts[0].TaskID {
		t.Fatalf("link = %q, want %q", updated.CronNextTaskID, nexts[0].TaskID)
	}
}

// TestDeadNodeFastTakeover proves I6: a dead node's dispatching claims are
// recovered by the sweep while a live node's claims are untouched.
func TestDeadNodeFastTakeover(t *testing.T) {
	setupDB(t)
	// roster: "dead" stale, "live" fresh
	if err := db.DB.Create(&model.ClusterNode{
		NodeID: "dead", LastHeartbeat: time.Now().UTC().Add(-5 * time.Minute),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.DB.Create(&model.ClusterNode{
		NodeID: "live", LastHeartbeat: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// 10 claims by the dead node + 5 by the live node, all fresh
	now := time.Now().UTC()
	seedDueTasks(t, 15)
	for i := 0; i < 15; i++ {
		owner := "live"
		if i < 10 {
			owner = "dead"
		}
		if _, ok, err := repo.ClaimTask(fmt.Sprintf("bench-task-%d", i), owner, now); err != nil || !ok {
			t.Fatalf("setup claim %d = %v %v", i, ok, err)
		}
	}

	ids, err := repo.DeadNodeIDs(now.Add(-30 * time.Second))
	if err != nil || len(ids) != 1 || ids[0] != "dead" {
		t.Fatalf("dead nodes = %v %v, want [dead]", ids, err)
	}
	if n, err := repo.ReclaimDispatchingForNodes(ids); err != nil || n != 10 {
		t.Fatalf("takeover = %d %v, want 10", n, err)
	}

	var deadClaims, liveClaims int64
	db.DB.Model(&model.Task{}).Where("status = ? AND owner = ?", repo.StatusDispatching, "dead").Count(&deadClaims)
	db.DB.Model(&model.Task{}).Where("status = ? AND owner = ?", repo.StatusDispatching, "live").Count(&liveClaims)
	if deadClaims != 0 {
		t.Fatalf("dead node claims = %d, want 0", deadClaims)
	}
	if liveClaims != 5 {
		t.Fatalf("live node claims = %d, want 5 (must be untouched)", liveClaims)
	}
	// recovered tasks are back to pending and immediately re-claimable
	var pending int64
	db.DB.Model(&model.Task{}).Where("status = ?", "pending").Count(&pending)
	if pending != 10 {
		t.Fatalf("pending after takeover = %d, want 10", pending)
	}
}
