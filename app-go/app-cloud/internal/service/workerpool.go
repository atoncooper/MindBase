// Bounded worker pool + durable outbox for the vectorize pipeline (multi-
// replica hardening, step ②).
//
// Before: every upload completion spawned an unbounded goroutine — a burst of
// N uploads meant N concurrent MinIO downloads + embedding batches with no
// backpressure, and a crash silently dropped every in-flight run (the row sat
// in "processing" until the stale reconcile marked it failed for the user).
//
// Now: completions/trigger/reprocess enqueue a row in cloud_vector_tasks (the
// queue), and StartWorkers runs a fixed pool that claims one task at a time
// with SELECT ... FOR UPDATE SKIP LOCKED — safe with any number of replicas,
// since a claimed row is invisible to the next claimer. A janitor requeues
// tasks whose claim exceeded staleProcessingAfter (crash recovery), and
// RunSync's idempotency guard makes the eventual re-run safe.
package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"app-cloud/internal/model"
)

const (
	// idlePollInterval is how long an idle worker waits before polling the
	// task queue again (enqueue also wakes workers immediately).
	idlePollInterval = 2 * time.Second
	// staleRequeueScan is the janitor cadence for crashed-claim recovery.
	staleRequeueScan = time.Minute
	// defaultPipelineWorkers applies when pipeline.workers is unset or <= 0.
	defaultPipelineWorkers = 4
	// maxPipelineWorkers caps a per-instance pool; the queue absorbs the rest.
	maxPipelineWorkers = 32
)

// StartWorkers launches the bounded pipeline worker pool + the stale-claim
// janitor. workers <= 0 means defaultPipelineWorkers; the value is clamped to
// [1, maxPipelineWorkers]. Idempotent: later calls are no-ops. Not
// restartable after StopWorkers (process shutdown path only).
func (p *Pipeline) StartWorkers(workers int) {
	if workers <= 0 {
		workers = defaultPipelineWorkers
	}
	if workers > maxPipelineWorkers {
		workers = maxPipelineWorkers
	}
	p.startOnce.Do(func() {
		for i := 0; i < workers; i++ {
			p.wg.Add(1)
			go p.workerLoop(i)
		}
		p.wg.Add(1)
		go p.janitorLoop()
		slog.Info("[CLOUD_PIPELINE] worker pool started", "workers", workers, "worker_id", p.workerID)
	})
}

// StopWorkers stops claiming new tasks and waits up to grace for in-flight
// runs. On timeout it gives up — the process is going down anyway and the
// stale-claim reaper recovers abandoned claims on next boot.
func (p *Pipeline) StopWorkers(grace time.Duration) {
	p.stopOnce.Do(func() {
		close(p.stop)
		done := make(chan struct{})
		go func() {
			p.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
			slog.Info("[CLOUD_PIPELINE] worker pool stopped cleanly")
		case <-time.After(grace):
			slog.Warn("[CLOUD_PIPELINE] worker pool stop timed out — abandoning in-flight tasks (recovered by the stale-claim reaper on next boot)")
		}
	})
}

// EnqueueTask upserts the durable outbox row for the file (one task per
// upload_uuid; re-enqueue resets only rows not currently being processed) and
// wakes an idle worker. The row IS the queue: if this write fails nothing
// would ever process the file, so the file is marked failed instead of being
// left in a pending limbo.
func (p *Pipeline) EnqueueTask(uploadUUID string, uid int64) error {
	if err := p.tasks.Enqueue(p.db, uploadUUID, uid); err != nil {
		_ = p.files.UpdateMeta(p.db, uploadUUID, uid, map[string]any{"vector_status": "failed"})
		return err
	}
	p.Wake()
	return nil
}

// Wake nudges one idle worker without blocking when the signal slot is full.
func (p *Pipeline) Wake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Pipeline) workerLoop(i int) {
	defer p.wg.Done()
	id := fmt.Sprintf("%s/w%d", p.workerID, i)
	for {
		task, err := p.tasks.ClaimNext(p.db, id)
		if err != nil {
			slog.Warn("[CLOUD_PIPELINE] claim failed", "worker", id, "err", err)
			if !p.sleepOrStop(idlePollInterval) {
				return
			}
			continue
		}
		if task == nil {
			if !p.waitIdle() {
				return
			}
			continue
		}
		p.execute(task)
	}
}

// waitIdle blocks until a wake signal, the poll interval, or shutdown.
func (p *Pipeline) waitIdle() bool {
	select {
	case <-p.stop:
		return false
	case <-p.wake:
		return true
	case <-time.After(idlePollInterval):
		return true
	}
}

func (p *Pipeline) sleepOrStop(d time.Duration) bool {
	select {
	case <-p.stop:
		return false
	case <-time.After(d):
		return true
	}
}

// janitorLoop requeues tasks claimed longer than staleProcessingAfter ago —
// the crash/kill recovery path. staleProcessingAfter comfortably exceeds
// pipelineTimeout, so a task requeued by the janitor cannot still be running
// anywhere (RunSync's own ctx fires at pipelineTimeout).
func (p *Pipeline) janitorLoop() {
	defer p.wg.Done()
	t := time.NewTicker(staleRequeueScan)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-t.C:
			n, err := p.tasks.RequeueStale(p.db, time.Now().Add(-staleProcessingAfter))
			if err != nil {
				slog.Warn("[CLOUD_PIPELINE] stale requeue scan failed", "err", err)
			} else if n > 0 {
				slog.Warn("[CLOUD_PIPELINE] requeued stale claims", "count", n)
				p.Wake()
			}
		}
	}
}

// execute runs one claimed task end-to-end and ALWAYS terminates the outbox
// row (done/failed) — a task must never sit in "processing" while nobody
// holds it, or the janitor would resurrect it.
func (p *Pipeline) execute(task *model.CloudVectorTask) {
	defer func() {
		if r := recover(); r != nil {
			logErr("[CLOUD_PIPELINE] panic", "worker", task.UploadUUID, r)
			_ = p.tasks.Finish(p.db, task.ID, "failed", fmt.Sprintf("panic: %v", r))
		}
	}()
	f, err := p.files.GetByUUID(p.db, task.UploadUUID, task.UID)
	if err != nil {
		_ = p.tasks.Finish(p.db, task.ID, "failed", err.Error())
		return
	}
	if f == nil {
		_ = p.tasks.Finish(p.db, task.ID, "failed", "cloud_files row missing")
		return
	}
	if _, err := p.RunSync(context.Background(), f); err != nil {
		_ = p.tasks.Finish(p.db, task.ID, "failed", err.Error())
		return
	}
	_ = p.tasks.Finish(p.db, task.ID, "done", "")
}
