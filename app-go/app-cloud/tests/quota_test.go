package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/cache/factory"
	"app-cloud/internal/service"
)

// newTestQuotaService builds a QuotaService against a fake app-pay endpoint
// (nil db/pending — TierFor touches neither).
func newTestQuotaService(t *testing.T, handler http.HandlerFunc) (*service.QuotaService, *int32) {
	t.Helper()
	return newTestQuotaServiceWithConfig(t, handler, nil)
}

// newTestQuotaServiceWithConfig 同 newTestQuotaService，但允许在构造前微调
// config（如缩短 MembershipCacheTTL 以测试过期）。
func newTestQuotaServiceWithConfig(t *testing.T, handler http.HandlerFunc, mutate func(*config.Config)) (*service.QuotaService, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	cfg := &config.Config{}
	cfg.Quota.MembershipBaseURL = srv.URL
	cfg.Quota.MembershipAPIKey = "k"
	cfg.Quota.MembershipCacheTTL = 60
	if mutate != nil {
		mutate(cfg)
	}
	tierCache, err := factory.New[int64, string](factory.Config{
		Backend:    factory.Local,
		MaxEntries: service.MembershipCacheMaxEntries,
	})
	if err != nil {
		t.Fatalf("build local tier cache: %v", err)
	}
	return service.NewQuotaService(cfg, nil, nil, tierCache), &calls
}

func membershipBody(tier string, active bool) string {
	b, _ := json.Marshal(map[string]any{"uid": 42, "tier": tier, "active": active, "expireAt": "2027-01-01T00:00:00"})
	return string(b)
}

// TierFor must cache membership lookups: repeated calls within the TTL hit
// the in-process cache instead of the app-pay endpoint.
func TestTierForCachesMembership(t *testing.T) {
	q, calls := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(membershipBody("vip", true)))
	})
	for i := 0; i < 3; i++ {
		tier, err := q.TierFor(context.Background(), 42)
		if err != nil || tier != "vip" {
			t.Fatalf("call %d: tier=%q err=%v", i, tier, err)
		}
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected 1 upstream call for 3 lookups, got %d", got)
	}
}

// app-pay unreachable → fail-closed to the free tier (never block uploads on
// a pay-service outage), with the error surfaced to the caller.
func TestTierForFailClosedToFreeOnUpstreamError(t *testing.T) {
	q, _ := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	tier, err := q.TierFor(context.Background(), 42)
	if err == nil {
		t.Fatal("expected an error to be surfaced")
	}
	if tier != "free" {
		t.Fatalf("fail-closed tier = %q, want free", tier)
	}
}

// Tier normalization: SVIP/VIP case-insensitive, inactive membership reads
// as free.
func TestTierForNormalization(t *testing.T) {
	cases := []struct {
		tier   string
		active bool
		want   string
	}{
		{"svip", true, "svip"},
		{"SVIP", true, "svip"},
		{" vip ", true, "vip"},
		{"vip", false, "free"},
		{"", true, "free"},
	}
	for _, c := range cases {
		q, _ := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(membershipBody(c.tier, c.active)))
		})
		tier, err := q.TierFor(context.Background(), 42)
		if err != nil || tier != c.want {
			t.Fatalf("tier=%q active=%v: got %q (err %v), want %q", c.tier, c.active, tier, err, c.want)
		}
	}
}

// 会员态缓存加固：并发同 uid 的 miss 只回源一次（手动单飞，等待者共享结果）。
func TestTierForSingleFlightCoalescesConcurrentMisses(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	q, calls := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(membershipBody("vip", true)))
	})

	const n = 16
	tiers := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tiers[i], errs[i] = q.TierFor(context.Background(), 42)
		}(i)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream membership request never started")
	}
	// 给其余 goroutine 时间进入等待（它们必须共享 leader 的 in-flight）。
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected exactly 1 upstream call while %d lookups wait, got %d", n, got)
	}
	close(release)
	wg.Wait()
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("single-flight violated: expected 1 upstream call, got %d", got)
	}
	for i := 0; i < n; i++ {
		if errs[i] != nil || tiers[i] != "vip" {
			t.Fatalf("lookup %d: tier=%q err=%v, want vip/nil", i, tiers[i], errs[i])
		}
	}
}

// 失败结果短 TTL 缓存：窗口内重复调用不再回源，且始终返回 free + 错误
// （fail-closed），窗口过后重新回源。
func TestTierForCachesFailureBriefly(t *testing.T) {
	oldFailureTTL := service.MembershipFailureCacheTTL
	service.MembershipFailureCacheTTL = 50 * time.Millisecond
	t.Cleanup(func() { service.MembershipFailureCacheTTL = oldFailureTTL })

	q, calls := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	for i := 0; i < 3; i++ {
		tier, err := q.TierFor(context.Background(), 42)
		if err == nil || tier != "free" {
			t.Fatalf("lookup %d: tier=%q err=%v, want free + error", i, tier, err)
		}
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("failed lookups should be cached: expected 1 upstream call, got %d", got)
	}

	time.Sleep(80 * time.Millisecond) // 超过失败短 TTL → 重新回源
	if _, err := q.TierFor(context.Background(), 42); err == nil {
		t.Fatal("expected the refreshed lookup to keep failing")
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected a refetch after the failure TTL, got %d upstream calls", got)
	}
}

// 成功 TTL 抖动必须落在 ±15% 内，且确实在抖动（不是固定 TTL）。
func TestMembershipCacheTTLJitterBounds(t *testing.T) {
	base := 60 * time.Second
	lo := time.Duration(float64(base) * 0.85)
	hi := time.Duration(float64(base) * 1.15)
	seen := make(map[time.Duration]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		ttl := service.MembershipCacheTTLWithJitter(base)
		// 1ms 容差吸收 float64 乘法的纳秒级舍入。
		if ttl < lo-time.Millisecond || ttl > hi+time.Millisecond {
			t.Fatalf("jittered TTL %v outside ±15%% of %v", ttl, base)
		}
		seen[ttl] = struct{}{}
	}
	if len(seen) < 10 {
		t.Fatalf("expected jittered TTLs to vary, got %d distinct values", len(seen))
	}
	if got := service.MembershipCacheTTLWithJitter(0); got != 0 {
		t.Fatalf("zero base TTL: got %v, want 0", got)
	}
	if got := service.MembershipCacheTTLWithJitter(-time.Second); got != 0 {
		t.Fatalf("negative base TTL: got %v, want 0", got)
	}
}

// 容量上限：写入量远超上限时缓存仍受控，不会无界增长。
// Ristretto is an admission cache (TinyLFU), so a cold working set may hold
// fewer than MaxCost entries; the contract is "never exceeds the cap", not
// "always fills to the cap".
func TestTierForCacheBounded(t *testing.T) {
	oldMax := service.MembershipCacheMaxEntries
	service.MembershipCacheMaxEntries = 8
	t.Cleanup(func() { service.MembershipCacheMaxEntries = oldMax })

	q, calls := newTestQuotaService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(membershipBody("vip", true)))
	})
	const lookups = 100
	for i := 1; i <= lookups; i++ {
		tier, err := q.TierFor(context.Background(), int64(i))
		if err != nil || tier != "vip" {
			t.Fatalf("lookup uid=%d: tier=%q err=%v", i, tier, err)
		}
		if got := q.MembershipCacheSize(); got > 8 {
			t.Fatalf("cache exceeded cap: size=%d after uid=%d", got, i)
		}
	}
	if got := q.MembershipCacheSize(); got > 8 {
		t.Fatalf("cache size = %d, want <= 8", got)
	}
	if got := atomic.LoadInt32(calls); got <= 0 || got > lookups {
		t.Fatalf("upstream calls = %d, want 1..%d", got, lookups)
	}
}

// 成功结果按带抖动的 TTL 过期：TTL 1s 时 600ms 内命中、超过 1.15s 上限后回源。
func TestTierForRefreshesAfterJitteredTTL(t *testing.T) {
	q, calls := newTestQuotaServiceWithConfig(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(membershipBody("vip", true)))
	}, func(cfg *config.Config) {
		cfg.Quota.MembershipCacheTTL = 1
	})
	if tier, err := q.TierFor(context.Background(), 42); err != nil || tier != "vip" {
		t.Fatalf("tier=%q err=%v", tier, err)
	}
	time.Sleep(600 * time.Millisecond) // 短于抖动下限 850ms → 命中
	if tier, err := q.TierFor(context.Background(), 42); err != nil || tier != "vip" {
		t.Fatalf("tier=%q err=%v", tier, err)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected cache hit within jittered TTL, got %d upstream calls", got)
	}
	time.Sleep(600 * time.Millisecond) // 累计 1.2s > 抖动上限 1.15s → 必须回源
	if tier, err := q.TierFor(context.Background(), 42); err != nil || tier != "vip" {
		t.Fatalf("tier=%q err=%v", tier, err)
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected refetch after jittered TTL, got %d upstream calls", got)
	}
}
