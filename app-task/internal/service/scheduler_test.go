package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupTestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.EmailMessage{}, &model.Script{}, &model.ScriptLog{}, &model.ClusterNode{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

// mustRegister creates a due (past trigger) task.
func mustRegister(t *testing.T, svc *TaskService, uid int64, taskType, payload, executorURL string, async bool, maxRetry int) string {
	t.Helper()
	taskID, err := svc.RegisterTask(uid, taskType, []byte(payload), executorURL, async, "", time.Now().UTC().Add(-time.Minute), maxRetry, 1)
	if err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}
	return taskID
}

func mustHTTPExecutor(t *testing.T) *executor.HTTPExecutor {
	t.Helper()
	return executor.NewHTTPExecutor(executor.HTTPOptions{Timeout: 5 * time.Second})
}

func newSched(t *testing.T) *Scheduler {
	t.Helper()
	reg := executor.NewRegistry()
	reg.Register("http", mustHTTPExecutor(t).Handler())
	return NewScheduler(reg, SchedulerOptions{Interval: 30 * time.Second})
}

// ── 同步执行：2xx → completed + 写 task_log ──────────────────────────

func TestScheduler_SyncSuccess(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{"a":1}`, srv.URL, false, 0)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" {
		t.Fatalf("status = %q, want completed", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "success" {
		t.Fatalf("logs = %+v, want 1 success entry", logs)
	}
}

// ── 异步：202 + async=true → running（等回调）───────────────────────

func TestScheduler_AsyncAccepted(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, srv.URL, true, 0)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "running" {
		t.Fatalf("status = %q, want running", task.Status)
	}
}

// ── 重试：500 + maxRetry=2 → retry → retry → failed ─────────────────

func TestScheduler_RetryPolicy(t *testing.T) {
	setupTestDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, srv.URL, false, 2)

	newSched(t).tick()
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "pending" || task.RetryCount != 1 || task.NextRetryAt == nil {
		t.Fatalf("after 1st failure: status=%q retry=%d, want pending/1", task.Status, task.RetryCount)
	}

	openRetry(t, taskID)
	newSched(t).tick()
	task, _ = repo.GetTaskByID(taskID)
	if task.Status != "pending" || task.RetryCount != 2 {
		t.Fatalf("after 2nd failure: status=%q retry=%d, want pending/2", task.Status, task.RetryCount)
	}

	openRetry(t, taskID)
	newSched(t).tick()
	task, _ = repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Fatalf("after retries exhausted: status=%q, want failed", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 3 {
		t.Fatalf("logs = %d, want 3 (retry,retry,failed)", len(logs))
	}
}

func openRetry(t *testing.T, taskID string) {
	t.Helper()
	past := time.Now().UTC().Add(-time.Minute)
	repo.ConditionalUpdate(taskID, "pending", "pending", map[string]any{"next_retry_at": past})
}

// ── 异步超时：running 超过 10m 未回调 → failed + timeout log ────────

func TestScheduler_RunningTimeout(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, "http://x", true, 0)
	repo.ConditionalUpdate(taskID, "pending", "running", nil)
	old := time.Now().UTC().Add(-20 * time.Minute)
	db.DB.Model(&model.Task{}).Where("task_id = ?", taskID).Update("updated_at", old)

	newSched(t).tick()

	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "failed" {
		t.Fatalf("status = %q, want failed (timeout)", task.Status)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "timeout" {
		t.Fatalf("logs = %+v, want timeout entry", logs)
	}
}

// ── 回调：executor 完成报告 → running → completed（幂等）─────────────

func TestTaskService_CompleteTask(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	taskID := mustRegister(t, svc, 1, "http", `{}`, "http://x", true, 0)
	repo.ConditionalUpdate(taskID, "pending", "running", nil)

	status, err := svc.CompleteTask(taskID, "completed", `{"score":90}`, "")
	if err != nil || status != "completed" {
		t.Fatalf("CompleteTask = %q, %v", status, err)
	}
	task, _ := repo.GetTaskByID(taskID)
	if task.Status != "completed" || task.LastResult == nil || *task.LastResult != `{"score":90}` {
		t.Fatalf("task = %+v", task)
	}
	logs, _ := repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 || logs[0].Status != "completed" {
		t.Fatalf("logs = %+v", logs)
	}

	// 幂等：重复回调返回当前状态，不产生新日志
	status, _ = svc.CompleteTask(taskID, "failed", "", "late")
	if status != "completed" {
		t.Fatalf("idempotent replay = %q, want completed", status)
	}
	logs, _ = repo.ListTaskLogs(taskID, 10)
	if len(logs) != 1 {
		t.Fatalf("logs after replay = %d, want 1", len(logs))
	}
}

// ── cron：周期任务在终态后克隆下一条 ────────────────────────────────

func TestScheduler_CronExtend(t *testing.T) {
	setBeijingLocal(t)
	setupTestDB(t)
	svc := NewTaskService()
	taskID, err := svc.RegisterTask(1, "http", nil, "http://x", false, "0 23 * * *", time.Now().UTC(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	repo.ConditionalUpdate(taskID, "pending", "completed", nil)

	newSched(t).tick()

	var next []model.Task
	db.DB.Where("cron_expr = ? AND status = ?", "0 23 * * *", "pending").Find(&next)
	if len(next) != 1 {
		t.Fatalf("next occurrences = %d, want 1", len(next))
	}
	if next[0].TaskID == taskID {
		t.Fatal("cloned task must have a new id")
	}
	orig, _ := repo.GetTaskByID(taskID)
	if orig.CronNextTaskID != next[0].TaskID {
		t.Fatalf("cron_next_task_id = %q, want %q", orig.CronNextTaskID, next[0].TaskID)
	}
}

func setBeijingLocal(t *testing.T) {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	old := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = old })
}

// ── 并行派发：慢执行器在一个 tick 内并行完成（worker 池生效）─────────

func TestScheduler_ParallelDispatch(t *testing.T) {
	setupTestDB(t)
	var active, maxActive int32
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := atomic.AddInt32(&active, 1)
		mu.Lock()
		if cur > maxActive {
			maxActive = cur
		}
		mu.Unlock()
		time.Sleep(300 * time.Millisecond)
		atomic.AddInt32(&active, -1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc := NewTaskService()
	var ids []string
	for i := 0; i < 10; i++ {
		ids = append(ids, mustRegister(t, svc, 1, "http", `{}`, srv.URL, false, 0))
	}

	started := time.Now()
	newSched(t).tick() // 默认 workers=16 > 10 → 全部并行
	elapsed := time.Since(started)
	if elapsed > 2*time.Second {
		t.Fatalf("tick took %v — dispatches did not run in parallel (serial would be 3s+)", elapsed)
	}
	mu.Lock()
	max := maxActive
	mu.Unlock()
	if max < 3 {
		t.Fatalf("max concurrent handlers = %d, want real parallelism (>2)", max)
	}
	for _, id := range ids {
		task, _ := repo.GetTaskByID(id)
		if task.Status != "completed" {
			t.Fatalf("task %s status = %q, want completed", id, task.Status)
		}
	}
}

// ── 认领互斥：同一任务只能被一个 worker/实例抢到；finalize 清空认领 ──

func TestClaimTask_MutexAndFinalize(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	id := mustRegister(t, svc, 1, "http", `{}`, "http://x", false, 0)
	now := time.Now().UTC()

	t1, w1, err1 := repo.ClaimTask(id, "inst-1", now)
	_, w2, err2 := repo.ClaimTask(id, "inst-2", now)
	if err1 != nil || err2 != nil {
		t.Fatalf("claim errors: %v %v", err1, err2)
	}
	if !w1 || w2 {
		t.Fatalf("claims = %v/%v, want true/false (exactly one winner)", w1, w2)
	}
	task, _ := repo.GetTaskByID(id)
	if task.Status != repo.StatusDispatching || task.Owner != "inst-1" || task.ClaimedAt == nil {
		t.Fatalf("claimed task = %+v", task)
	}

	// finalize（dispatching → completed，fenced by claim token）清空认领字段
	ok, _ := repo.FinalizeClaim(id, t1, "completed",
		map[string]any{"owner": "", "claimed_at": nil})
	if !ok {
		t.Fatal("finalize from dispatching failed")
	}
	task, _ = repo.GetTaskByID(id)
	if task.Status != "completed" || task.Owner != "" || task.ClaimedAt != nil {
		t.Fatalf("finalized task = %+v", task)
	}
}

// ── 回收：超时的 dispatching 认领被收回并重派（at-least-once）────────

func TestScheduler_ReclaimStaleDispatching(t *testing.T) {
	setupTestDB(t)
	reg := executor.NewRegistry()
	var calls int32
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		atomic.AddInt32(&calls, 1)
		return fmt.Errorf("boom")
	}))
	s := NewScheduler(reg, SchedulerOptions{
		Interval:       time.Second,
		Workers:        4,
		DispatchingTTL: time.Minute,
	})

	svc := NewTaskService()
	id := mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0)
	if _, ok, _ := repo.ClaimTask(id, "dead-instance", time.Now().UTC()); !ok {
		t.Fatal("claim failed")
	}
	// 认领时间回拨到 TTL 之外（模拟派发后实例崩溃）
	db.DB.Model(&model.Task{}).Where("task_id = ?", id).
		Update("claimed_at", time.Now().UTC().Add(-5*time.Minute))

	s.tick() // 回收 → 同一 tick 重派 → handler 失败 → maxRetry=0 → failed

	task, _ := repo.GetTaskByID(id)
	if task.Status != "failed" {
		t.Fatalf("status = %q, want failed (reclaimed + redispatched)", task.Status)
	}
	if task.Owner != "" || task.ClaimedAt != nil {
		t.Fatalf("claim not cleared after finalize: %+v", task)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("handler calls = %d, want 1 (reclaimed task was re-dispatched once)", calls)
	}
}

// ── per-URL 并发闸：单个执行器最多占用 limit 个槽位 ──────────────────

func TestScheduler_PerURLGate(t *testing.T) {
	setupTestDB(t)
	var inflight, maxInflight int32
	var mu sync.Mutex
	reg := executor.NewRegistry()
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		cur := atomic.AddInt32(&inflight, 1)
		mu.Lock()
		if cur > maxInflight {
			maxInflight = cur
		}
		mu.Unlock()
		time.Sleep(100 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		return nil
	}))
	s := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 8, PerURLLimit: 2})

	svc := NewTaskService()
	var ids []string
	for i := 0; i < 6; i++ {
		ids = append(ids, mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0))
	}
	for tick := 0; tick < 4; tick++ {
		s.tick() // 每 tick 该 URL 最多并行 2 个；饱和的任务留在 pending 下个 tick 再试
	}
	mu.Lock()
	max := maxInflight
	mu.Unlock()
	if max > 2 {
		t.Fatalf("max concurrent per URL = %d, want <= 2", max)
	}
	for _, id := range ids {
		task, _ := repo.GetTaskByID(id)
		if task.Status != "completed" {
			t.Fatalf("task %s status = %q, want completed after repeated ticks", id, task.Status)
		}
	}
}

// ── 优雅停机：Stop 等待 in-flight 派发完成后才返回 ───────────────────

func TestScheduler_GracefulStop(t *testing.T) {
	setupTestDB(t)
	var completed int32
	reg := executor.NewRegistry()
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		time.Sleep(300 * time.Millisecond)
		atomic.AddInt32(&completed, 1)
		return nil
	}))
	s := NewScheduler(reg, SchedulerOptions{Interval: time.Hour, Workers: 4})
	s.Start()

	svc := NewTaskService()
	for i := 0; i < 4; i++ {
		mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0)
	}
	go s.tick()                        // 手动触发一批（Start 时的首扫在注册前已跑完）
	time.Sleep(150 * time.Millisecond) // 让 4 个派发都进入 in-flight

	s.Stop() // 必须等待 in-flight 完成（30s 上限内）

	if got := atomic.LoadInt32(&completed); got != 4 {
		t.Fatalf("completed after graceful stop = %d, want 4", got)
	}
}

// ── 集群验收：两个实例并发 tick，任务不重不漏 ────────────────────────
// 正确性来自条件认领更新（ClaimTasksBatch 事务内的 status='pending' 过滤）；
// MySQL 上额外的 FOR UPDATE SKIP LOCKED 只是不竞争的效率优化，SQLite
// 测试库没有该子句，覆盖的是同一条正确性路径。

func TestScheduler_MultiInstanceNoDoubleDispatch(t *testing.T) {
	setupTestDB(t)
	var mu sync.Mutex
	calls := map[string]int{}
	reg := executor.NewRegistry()
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		mu.Lock()
		calls[task.ID]++
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		return nil
	}))

	svc := NewTaskService()
	var ids []string
	for i := 0; i < 20; i++ {
		ids = append(ids, mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0))
	}

	inst1 := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 8, Owner: "inst-1"})
	inst2 := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 8, Owner: "inst-2"})

	// 第一波：两实例同时 tick。每实例 claimLimit = min(50, 8) = 8，一波最多
	// 派发 16 个——这一波只验证核心不变量：任何任务都恰好被派发一次。
	var both sync.WaitGroup
	both.Add(2)
	go func() { defer both.Done(); inst1.tick() }()
	go func() { defer both.Done(); inst2.tick() }()
	both.Wait()

	mu.Lock()
	for id, n := range calls {
		if n != 1 {
			mu.Unlock()
			t.Fatalf("task %s dispatched %d times, want exactly 1", id, n)
		}
	}
	mu.Unlock()

	// 后续波：补派剩余 pending 任务直到全部完成（真实集群里就是后续 tick）。
	for round := 0; round < 5; round++ {
		var pending int64
		db.DB.Model(&model.Task{}).Where("status = ?", "pending").Count(&pending)
		if pending == 0 {
			break
		}
		inst1.tick()
		inst2.tick()
	}

	mu.Lock()
	defer mu.Unlock()
	if len(calls) != len(ids) {
		t.Fatalf("distinct dispatched tasks = %d, want %d", len(calls), len(ids))
	}
	for _, id := range ids {
		if n := calls[id]; n != 1 {
			t.Fatalf("task %s dispatched %d times, want exactly 1", id, n)
		}
		task, _ := repo.GetTaskByID(id)
		if task.Status != "completed" {
			t.Fatalf("task %s status = %q, want completed", id, task.Status)
		}
	}
}

// ── fencing：陈旧持有者不能覆盖新认领（核心一致性保证）───────────────

func TestFinalizeClaimFencing(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	id := mustRegister(t, svc, 1, "http", `{}`, "http://x", false, 0)
	now := time.Now().UTC()

	// 实例 A 认领（token1），随后卡顿超 TTL → 被回收 → 实例 B 重新认领（token2）
	tok1, w1, err1 := repo.ClaimTask(id, "inst-a", now)
	if n, rerr := repo.ReclaimDispatching(now.Add(time.Minute)); rerr != nil || n != 1 {
		t.Fatalf("reclaim = %d %v, want 1 (TTL expired)", n, rerr)
	}
	tok2, w2, err2 := repo.ClaimTask(id, "inst-b", now.Add(time.Second))
	if err1 != nil || err2 != nil || !w1 || !w2 {
		t.Fatalf("claims: %v/%v %v/%v", w1, w2, err1, err2)
	}
	task, _ := repo.GetTaskByID(id)
	if task.ClaimToken != tok2 || task.ClaimToken == tok1 {
		t.Fatalf("re-claim must mint a fresh token, got %q (old %q)", task.ClaimToken, tok1)
	}

	// A 的迟到 finalize 必须被拒（孤儿结果，状态不被污染）
	ok1, _ := repo.FinalizeClaim(id, tok1, "completed", map[string]any{"last_result": "stale"})
	if ok1 {
		t.Fatal("stale holder finalized over the newer claim — fencing broken")
	}
	// A 的迟到 release 同样被拒
	okRel, _ := repo.ReleaseClaim(id, tok1)
	if okRel {
		t.Fatal("stale holder released the newer claim — fencing broken")
	}

	// B（当前持有者）finalize 正常成功
	ok2, _ := repo.FinalizeClaim(id, task.ClaimToken, "completed", map[string]any{"last_result": "ok"})
	if !ok2 {
		t.Fatal("current holder finalize failed")
	}
	task, _ = repo.GetTaskByID(id)
	if task.Status != "completed" {
		t.Fatalf("status = %q, want completed", task.Status)
	}
}

// ── cron 延展原子性：并发延展绝不产生孤儿重复 ────────────────────────

func TestCronExtendAtomic(t *testing.T) {
	setupTestDB(t)
	svc := NewTaskService()
	origID, err := svc.RegisterTask(1, "http", nil, "http://x", false, "0 23 * * *", time.Now().UTC(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	repo.ConditionalUpdate(origID, "pending", "completed", nil)
	orig, _ := repo.GetTaskByID(origID)

	// 两实例同时延展同一终态 cron 任务
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); repo.ExtendCronTask(orig, time.Now().UTC().Add(time.Hour)) }()
	go func() { defer wg.Done(); repo.ExtendCronTask(orig, time.Now().UTC().Add(time.Hour)) }()
	wg.Wait()

	// 只允许存在一条 next occurrence；且原任务链接指向它
	var nexts []model.Task
	db.DB.Where("cron_expr = ? AND status = ?", "0 23 * * *", "pending").Find(&nexts)
	if len(nexts) != 1 {
		t.Fatalf("next occurrences = %d, want exactly 1 (orphan duplicate must not exist)", len(nexts))
	}
	orig, _ = repo.GetTaskByID(origID)
	if orig.CronNextTaskID != nexts[0].TaskID {
		t.Fatalf("link = %q, want winner %q", orig.CronNextTaskID, nexts[0].TaskID)
	}
}

// ── 集群接管：心跳失联节点的认领被即时接管（不等 120s TTL）────────────

func TestScheduler_DeadNodeTakeover(t *testing.T) {
	setupTestDB(t)

	// 一个心跳已失联的节点（名册行存在但 last_heartbeat 停在 5 分钟前）
	dead := &model.ClusterNode{NodeID: "dead-node", LastHeartbeat: time.Now().UTC().Add(-5 * time.Minute)}
	if err := db.DB.Create(dead).Error; err != nil {
		t.Fatal(err)
	}

	reg := executor.NewRegistry()
	var calls int32
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		atomic.AddInt32(&calls, 1)
		return nil
	}))
	s := NewScheduler(reg, SchedulerOptions{
		Interval:       time.Second,
		Workers:        4,
		DispatchingTTL: 10 * time.Minute, // TTL 很长：接管必须来自死节点判定而非 TTL
	})
	s.SetClusterView(stubClusterView{dead: []string{"dead-node"}, maxWeight: 1})

	svc := NewTaskService()
	id := mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0)
	// dead-node 已认领且 claimed_at 很新（刚崩掉的实例）
	if _, ok, _ := repo.ClaimTask(id, "dead-node", time.Now().UTC()); !ok {
		t.Fatal("claim failed")
	}

	s.tick() // 死节点快速接管 → 重派 → 成功

	task, _ := repo.GetTaskByID(id)
	if task.Status != "completed" {
		t.Fatalf("status = %q, want completed (taken over and re-dispatched)", task.Status)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("handler calls = %d, want 1", calls)
	}
}

// stubClusterView fakes the cluster roster for scheduler tests.
type stubClusterView struct {
	dead      []string
	maxWeight int
}

func (s stubClusterView) DeadNodes() []string { return s.dead }
func (s stubClusterView) MaxAliveWeight() int { return s.maxWeight }

// ── 权重认领上限：低权重节点每 tick 只认领 base×weight/maxWeight ──────

func TestScheduler_WeightedClaimLimit(t *testing.T) {
	setupTestDB(t)
	reg := executor.NewRegistry()
	var calls int32
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		atomic.AddInt32(&calls, 1)
		return nil
	}))

	svc := NewTaskService()
	for i := 0; i < 8; i++ {
		mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0)
	}

	// 低权重节点：base=min(50,4)=4，weight=1、max=4 → 每 tick 只认领 1 个
	low := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 4, Weight: 1})
	low.SetClusterView(stubClusterView{maxWeight: 4})
	low.tick()
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("low-weight node dispatched %d, want exactly 1 (limit = ceil(4*1/4))", calls)
	}

	// 高权重节点：weight=max=4 → 满额认领 4 个
	high := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 4, Weight: 4})
	high.SetClusterView(stubClusterView{maxWeight: 4})
	high.tick()
	if atomic.LoadInt32(&calls) != 5 {
		t.Fatalf("after high-weight tick calls = %d, want 5 (1+4)", calls)
	}

	// 交替到清零：低 1 + 高 3（剩 3 个）
	low.tick()
	high.tick()
	if atomic.LoadInt32(&calls) != 8 {
		t.Fatalf("calls = %d, want 8 (all tasks dispatched)", calls)
	}
	var pending int64
	db.DB.Model(&model.Task{}).Where("status = ?", "pending").Count(&pending)
	if pending != 0 {
		t.Fatalf("pending = %d, want 0", pending)
	}
}

// ── 加入流程：预登记 → 心跳转正（Web/CLI 加入的唯一合法途径）──────────

func TestClusterJoinFlow(t *testing.T) {
	// setupTestDB 已含 ClusterNode（集群相关测试共用此 helper）
	setupTestDB(t)

	// 1. manager 预登记 worker-3（weight 4）
	created, err := repo.JoinNode(&model.ClusterNode{
		NodeID: "worker-3", Weight: 4, State: repo.NodeStatePendingJoin,
		JoinedVia: "web", InvitedBy: "admin",
	})
	if err != nil || !created {
		t.Fatalf("join = %v %v", created, err)
	}
	row, _ := repo.GetClusterNode("worker-3")
	if row == nil || row.State != repo.NodeStatePendingJoin || row.Weight != 4 || row.InvitedBy != "admin" {
		t.Fatalf("pending row = %+v", row)
	}

	// 2. 重复预登记（幂等刷新，不算错误）
	created2, err := repo.JoinNode(&model.ClusterNode{
		NodeID: "worker-3", Weight: 8, State: repo.NodeStatePendingJoin, InvitedBy: "admin",
	})
	if err != nil || created2 {
		t.Fatalf("repeat join = %v %v, want false/nil", created2, err)
	}

	// 3. 已 active 的 node_id 再加入 → ErrNodeActive
	if _, ok, _ := repo.ClaimTask(mustRegister(t, NewTaskService(), 1, "http", `{}`, "http://x", false, 0), "inst-x", time.Now().UTC()); !ok {
		t.Fatal("setup claim failed")
	}
	// 直接造一个 active 节点：心跳注册
	if err := repo.UpsertNodeHeartbeat(&model.ClusterNode{NodeID: "worker-3", Weight: 8}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.JoinNode(&model.ClusterNode{NodeID: "worker-3", Weight: 1}); err != repo.ErrNodeActive {
		t.Fatalf("join active node err = %v, want ErrNodeActive", err)
	}
	// 心跳转正后 weight 以节点 env 为准（8）
	row, _ = repo.GetClusterNode("worker-3")
	if row.State != repo.NodeStateActive || row.Weight != 8 || row.JoinedVia != "web" {
		t.Fatalf("activated row = %+v", row)
	}
}

// ── 比例分布：多节点 + 不同权重，认领机制自动按权重分摊（无需偏移量切分）─

func TestScheduler_ProportionalDistribution(t *testing.T) {
	setupTestDB(t)
	reg := executor.NewRegistry()
	var mu sync.Mutex
	counts := map[string]int{}
	reg.Register("http", executor.Handler(func(ctx context.Context, task executor.Task) error {
		owner, _ := task.Meta["owner"].(string)
		mu.Lock()
		counts[owner]++
		mu.Unlock()
		return nil
	}))

	svc := NewTaskService()
	const total = 600
	for i := 0; i < total; i++ {
		mustRegister(t, svc, 1, "http", `{}`, "http://gate", false, 0)
	}

	// 三节点：权重 1/2/3（如 manager + 两台 worker 的高权重模拟）
	nodes := []struct {
		id     string
		weight int
	}{
		{"node-mgr", 1}, {"node-w1", 2}, {"node-w2", 3},
	}
	scheds := make([]*Scheduler, 0, len(nodes))
	for _, n := range nodes {
		s := NewScheduler(reg, SchedulerOptions{Interval: time.Second, Workers: 50, Weight: n.weight, Owner: n.id})
		s.SetClusterView(stubClusterView{maxWeight: 3})
		scheds = append(scheds, s)
	}

	// 轮流 tick 直到全部派发完成
	for round := 0; round < 200; round++ {
		var pending int64
		db.DB.Model(&model.Task{}).Where("status IN ?", []string{"pending", "dispatching"}).Count(&pending)
		if pending == 0 {
			break
		}
		for _, s := range scheds {
			s.tick()
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if len(counts) != len(nodes) {
		t.Fatalf("nodes that dispatched = %d, want %d", len(counts), len(nodes))
	}
	// 期望比例 1:2:3（共 600 → 100/200/300），允许 ±20% 舍入/调度抖动
	expected := map[string]float64{"node-mgr": 100, "node-w1": 200, "node-w2": 300}
	for _, n := range nodes {
		got := float64(counts[n.id])
		want := expected[n.id]
		if got < want*0.8 || got > want*1.2 {
			t.Fatalf("node %s dispatched %d, want ~%.0f (±20%%)", n.id, int(got), want)
		}
		t.Logf("node %s dispatched %d (target %.0f)", n.id, int(got), want)
	}
	got := 0
	for _, c := range counts {
		got += c
	}
	if got != total {
		t.Fatalf("total dispatched = %d, want %d (no task lost or duplicated)", got, total)
	}
}

// ── weight 钳制：极端配置不会让加权算术溢出 ──────────────────────────

func TestSchedulerWeightClamp(t *testing.T) {
	s := NewScheduler(executor.NewRegistry(), SchedulerOptions{Workers: 4, Weight: 1 << 40})
	if s.weight != 10000 {
		t.Fatalf("weight = %d, want clamped to 10000", s.weight)
	}
}
