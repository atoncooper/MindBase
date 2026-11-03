package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

// baseConfig is a fully-populated test configuration (no file/env loading).
func baseConfig() *config.Config {
	return &config.Config{
		App:      config.AppConfig{Name: "app-sandbox"},
		Server:   config.ServerConfig{Host: "127.0.0.1", Port: 8017},
		Log:      config.LogConfig{Level: "error", Format: "json", Output: "stdout"},
		Timezone: "UTC",
		Database: config.DatabaseConfig{DSN: "memory"},
		Auth:     config.AuthConfig{APIKey: "test-key"},
		Runtime: config.RuntimeConfig{
			Type:      config.RuntimeFake,
			Image:     "python:3.12",
			Resources: config.ResourceConfig{CPU: "500m", Memory: "512Mi"},
		},
		Execution: config.ExecutionConfig{
			MaxTimeoutMS:          600000,
			PreviewBytes:          64,
			MaxCodeBytes:          262144,
			IdempotencyTTLSeconds: 300,
		},
		Lease:     config.LeaseConfig{TTLSeconds: 1800, MaxPerUID: 3},
		Admission: config.AdmissionConfig{MaxConcurrent: 8, MaxPerUID: 4, QueueSize: 32, QueueTimeoutMS: 30000},
		Quota: config.QuotaConfig{
			Enabled: false,
			Limits: map[string]config.TierLimit{
				config.QuotaAcademicRun:   {Free: 20, VIP: 200, SVIP: 600},
				config.QuotaConcurrent:    {Free: 1, VIP: 3, SVIP: 5},
				config.QuotaCPUSeconds:    {Free: 300, VIP: 3600, SVIP: 10800},
				config.QuotaArtifactBytes: {Free: 50 << 20, VIP: 500 << 20, SVIP: 2 << 30},
			},
		},
		Artifacts: config.ArtifactsConfig{
			PresignTTLSeconds: 900,
			MaxFileBytes:      20 << 20,
			MaxTotalBytes:     100 << 20,
			DefaultGlobs:      []string{"/workspace/analysis/outputs/**"},
		},
		Sweeper: config.SweeperConfig{IntervalMS: 15000, OrphanDryRun: true, CreateTimeoutMS: 60000},
	}
}

// testEnv wires the whole control plane on memory repositories + the fake
// runtime: the exact composition main.go performs, minus MySQL/HTTP.
type testEnv struct {
	cfg        *config.Config
	store      *repo.Memory
	rt         *runtime.Fake
	metrics    *metrics.Metrics
	quota      *QuotaService
	admission  *Admission
	leases     *LeaseManager
	executions *ExecutionService
	sweeper    *Sweeper
	artifacts  *FakeArtifactStore
}

func newTestEnv(t *testing.T, fakeOpts runtime.FakeOptions, tweak func(*config.Config, *runtime.Fake)) *testEnv {
	t.Helper()
	cfg := baseConfig()
	rt := runtime.NewFakeWith(fakeOpts)
	if tweak != nil {
		tweak(cfg, rt)
	}
	store := repo.NewMemory()
	m := metrics.New()
	quota := NewQuotaService(cfg, store, m)
	leases := NewLeaseManager(cfg, rt, store, store, store, quota, m)
	admission := NewAdmission(cfg, m)
	artifactStore := NewFakeArtifactStore()
	executions := NewExecutionService(ExecutionDeps{
		Config:        cfg,
		Executions:    store,
		Artifacts:     store,
		Usage:         store,
		Audit:         store,
		Leases:        leases,
		Quota:         quota,
		Admission:     admission,
		Runtime:       rt,
		ArtifactStore: artifactStore,
		Metrics:       m,
	})
	leases.SetCanceler(executions)
	sweeper := NewSweeper(cfg, store, leases, executions, store, rt, m)
	env := &testEnv{
		cfg:        cfg,
		store:      store,
		rt:         rt,
		metrics:    m,
		quota:      quota,
		admission:  admission,
		leases:     leases,
		executions: executions,
		sweeper:    sweeper,
		artifacts:  artifactStore,
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		env.executions.Shutdown(ctx)
	})
	return env
}

// waitTerminal polls until the execution reaches a terminal state.
func (e *testEnv) waitTerminal(t *testing.T, uid int64, id string) *model.SandboxExecution {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		exec, err := e.store.GetExecution(context.Background(), id)
		if err == nil && model.IsExecTerminal(exec.Status) {
			return exec
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("execution %s did not reach a terminal state in time", id)
	return nil
}

// waitStatus polls until the execution reaches the given status.
func (e *testEnv) waitStatus(t *testing.T, id, status string) *model.SandboxExecution {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		exec, err := e.store.GetExecution(context.Background(), id)
		if err == nil && exec.Status == status {
			return exec
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("execution %s never reached status %s", id, status)
	return nil
}

// mustCreate creates an execution and fails the test on error.
func (e *testEnv) mustCreate(t *testing.T, req CreateRequest) *model.SandboxExecution {
	t.Helper()
	exec, err := e.executions.Create(context.Background(), req)
	if err != nil {
		t.Fatalf("create execution: %v", err)
	}
	return exec
}
