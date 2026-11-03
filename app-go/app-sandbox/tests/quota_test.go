package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

func TestQuotaDisabledAllowsEverything(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil) // quota disabled by default
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	if err := env.store.IncrementUsage(ctx, 1, day, repo.UsageDelta{Executions: 999, CPUMillis: 1_000_000, ArtifactBytes: 1 << 40}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	if err := env.quota.CheckExecution(ctx, 1); err != nil {
		t.Fatalf("disabled quota must allow execution: %v", err)
	}
	if err := env.quota.CheckArtifact(ctx, 1, 1); err != nil {
		t.Fatalf("disabled quota must allow artifacts: %v", err)
	}
	if limit, _ := env.quota.ConcurrentLimit(ctx, 1); limit != int64(env.cfg.Lease.MaxPerUID) {
		t.Fatalf("disabled quota concurrent limit = %d, want hard cap %d", limit, env.cfg.Lease.MaxPerUID)
	}
}

func TestQuotaAcademicRunExceeded(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	if err := env.store.IncrementUsage(ctx, 2, day, repo.UsageDelta{Executions: 20}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	err := env.quota.CheckExecution(ctx, 2)
	var quotaErr *QuotaExceededError
	if !errors.As(err, &quotaErr) {
		t.Fatalf("want QuotaExceededError, got %v", err)
	}
	if quotaErr.Kind != config.QuotaAcademicRun || quotaErr.Tier != string(TierFree) || quotaErr.Limit != 20 {
		t.Fatalf("unexpected quota error: %+v", quotaErr)
	}
	if !quotaErr.ResetAt.After(time.Now().Add(-time.Minute)) {
		t.Fatalf("resetAt = %v, want a future local midnight", quotaErr.ResetAt)
	}
	if quotaErr.UpgradeSKU() != string(TierVIP) {
		t.Fatalf("upgrade sku = %q, want vip", quotaErr.UpgradeSKU())
	}
}

func TestQuotaCPUSecondsExceeded(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	// free tier allows 300 CPU-seconds = 300_000 CPU-millis
	if err := env.store.IncrementUsage(ctx, 3, day, repo.UsageDelta{CPUMillis: 300_000}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	err := env.quota.CheckExecution(ctx, 3)
	var quotaErr *QuotaExceededError
	if !errors.As(err, &quotaErr) || quotaErr.Kind != config.QuotaCPUSeconds {
		t.Fatalf("want cpu-seconds quota error, got %v", err)
	}
}

func TestQuotaArtifactBytesExceeded(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	if err := env.store.IncrementUsage(ctx, 4, day, repo.UsageDelta{ArtifactBytes: 50 << 20}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	err := env.quota.CheckArtifact(ctx, 4, 1)
	var quotaErr *QuotaExceededError
	if !errors.As(err, &quotaErr) || quotaErr.Kind != config.QuotaArtifactBytes {
		t.Fatalf("want artifact-bytes quota error, got %v", err)
	}
}

func TestQuotaTierFromAppPayAndCache(t *testing.T) {
	var requests atomic.Int64
	var sawPath, sawKey atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		sawPath.Store(r.URL.Path)
		sawKey.Store(r.Header.Get("apikey"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"uid":42,"active":true,"tier":"SVIP"}`))
	}))
	defer server.Close()

	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
		cfg.Quota.AppPay.BaseURL = server.URL
		cfg.Quota.AppPay.APIKey = "pay-key"
		cfg.Quota.AppPay.CacheTTLMS = 60000
		cfg.Lease.MaxPerUID = 3
	})
	ctx := context.Background()
	if tier := env.quota.TierFor(ctx, 42); tier != TierSVIP {
		t.Fatalf("tier = %s, want svip", tier)
	}
	if tier := env.quota.TierFor(ctx, 42); tier != TierSVIP {
		t.Fatalf("cached tier = %s, want svip", tier)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("membership lookups = %d, want 1 (cached)", got)
	}
	if got, _ := sawPath.Load().(string); got != "/membership/42" {
		t.Fatalf("membership path = %q", got)
	}
	if got, _ := sawKey.Load().(string); got != "pay-key" {
		t.Fatalf("membership apikey = %q", got)
	}
	// svip concurrent limit 5 is capped by the hard lease.maxPerUid ceiling (3).
	if limit, tier := env.quota.ConcurrentLimit(ctx, 42); limit != 3 || tier != TierSVIP {
		t.Fatalf("concurrent limit = (%d,%s), want (3,svip)", limit, tier)
	}
	if limit := env.quota.Limit(config.QuotaAcademicRun, TierSVIP); limit != 600 {
		t.Fatalf("svip academic_run limit = %d, want 600", limit)
	}
}

func TestQuotaFailsOpenToFreeWhenAppPayDown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
		cfg.Quota.AppPay.BaseURL = server.URL
	})
	ctx := context.Background()
	if tier := env.quota.TierFor(ctx, 43); tier != TierFree {
		t.Fatalf("tier on app-pay outage = %s, want free", tier)
	}
	if limit := env.quota.Limit(config.QuotaAcademicRun, TierFree); limit != 20 {
		t.Fatalf("free limit = %d, want 20", limit)
	}
}

func TestQuotaRejectsCreateWhenDailyLimitReached(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := env.quota.Day(time.Now())
	if err := env.store.IncrementUsage(ctx, 44, day, repo.UsageDelta{Executions: 20}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	_, err := env.executions.Create(ctx, CreateRequest{UID: 44, Language: "python", Code: "print(1)"})
	var quotaErr *QuotaExceededError
	if !errors.As(err, &quotaErr) || quotaErr.Kind != config.QuotaAcademicRun {
		t.Fatalf("want academic_run quota rejection, got %v", err)
	}
	// No execution row may exist after a quota rejection.
	rows, _ := env.store.ListExecutionsByUID(ctx, 44, 10)
	if len(rows) != 0 {
		t.Fatalf("quota rejection created %d rows", len(rows))
	}
}

func TestQuotaLimitTable(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	cases := []struct {
		kind            string
		free, vip, svip int64
	}{
		{config.QuotaAcademicRun, 20, 200, 600},
		{config.QuotaConcurrent, 1, 3, 5},
		{config.QuotaCPUSeconds, 300, 3600, 10800},
		{config.QuotaArtifactBytes, 50 << 20, 500 << 20, 2 << 30},
	}
	for _, c := range cases {
		if got := env.quota.Limit(c.kind, TierFree); got != c.free {
			t.Errorf("free %s = %d, want %d", c.kind, got, c.free)
		}
		if got := env.quota.Limit(c.kind, TierVIP); got != c.vip {
			t.Errorf("vip %s = %d, want %d", c.kind, got, c.vip)
		}
		if got := env.quota.Limit(c.kind, TierSVIP); got != c.svip {
			t.Errorf("svip %s = %d, want %d", c.kind, got, c.svip)
		}
	}
	if !strings.HasPrefix(env.quota.Day(time.Now()), time.Now().UTC().Format("2006-01")) {
		t.Fatalf("day key = %q", env.quota.Day(time.Now()))
	}
}
