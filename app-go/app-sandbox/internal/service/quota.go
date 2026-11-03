package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

// Tier is the normalized membership tier (app-pay persists VIP|SVIP/absent).
type Tier string

const (
	TierFree Tier = "free"
	TierVIP  Tier = "vip"
	TierSVIP Tier = "svip"
)

type tierCacheEntry struct {
	tier      Tier
	expiresAt time.Time
}

// QuotaService enforces the four daily/realtime quota dimensions and resolves
// the membership tier from app-pay (60s in-process cache, fail-open to free: a
// pay-service outage must never grant a paid tier, but it also must not block
// every user).
type QuotaService struct {
	cfg     *config.Config
	usage   repo.UsageRepo
	metrics *metrics.Metrics
	http    *http.Client
	tz      *time.Location
	now     func() time.Time

	mu    sync.Mutex
	cache map[int64]tierCacheEntry
}

// NewQuotaService wires the quota service.
func NewQuotaService(cfg *config.Config, usage repo.UsageRepo, m *metrics.Metrics) *QuotaService {
	tz := time.Local
	if loc, err := time.LoadLocation(cfg.Timezone); err == nil {
		tz = loc
	}
	timeout := time.Duration(cfg.Quota.AppPay.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	svc := &QuotaService{
		cfg:     cfg,
		usage:   usage,
		metrics: m,
		http:    &http.Client{Timeout: timeout},
		tz:      tz,
		now:     time.Now,
		cache:   make(map[int64]tierCacheEntry),
	}
	if cfg.Quota.Enabled && strings.TrimSpace(cfg.Quota.AppPay.BaseURL) == "" {
		// A missing pay URL silently downgrades every SVIP/VIP to free; make the
		// misconfiguration loud instead of only showing up as wrong quota limits.
		slog.Warn("[QUOTA] app-pay baseUrl is empty; every user falls back to free",
			"hint", "set APP_PAY_BASE_URL or SANDBOX__QUOTA__APP_PAY__BASE_URL")
	}
	return svc
}

// Day is the business-local date key of the usage ledger.
func (s *QuotaService) Day(now time.Time) string {
	return now.In(s.tz).Format("2006-01-02")
}

// ResetAt is the next local midnight (quota reset moment).
func (s *QuotaService) ResetAt(now time.Time) time.Time {
	local := now.In(s.tz)
	return time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, s.tz)
}

// Limit returns the configured limit of one kind for a tier (0 = unlimited).
func (s *QuotaService) Limit(kind string, tier Tier) int64 {
	row := s.cfg.QuotaLimit(kind)
	switch tier {
	case TierSVIP:
		return row.SVIP
	case TierVIP:
		return row.VIP
	default:
		return row.Free
	}
}

// ConcurrentLimit returns the effective per-uid lease cap: the tier limit
// capped by the hard lease.maxPerUid ceiling.
func (s *QuotaService) ConcurrentLimit(ctx context.Context, uid int64) (int64, Tier) {
	hard := int64(s.cfg.Lease.MaxPerUID)
	if !s.cfg.Quota.Enabled {
		return hard, TierFree
	}
	tier := s.TierFor(ctx, uid)
	limit := s.Limit(config.QuotaConcurrent, tier)
	if limit <= 0 || limit > hard {
		limit = hard
	}
	return limit, tier
}

// TierFor resolves the membership tier (cached, fail-open to free).
func (s *QuotaService) TierFor(ctx context.Context, uid int64) Tier {
	if strings.TrimSpace(s.cfg.Quota.AppPay.BaseURL) == "" {
		return TierFree
	}
	now := s.now()
	s.mu.Lock()
	if entry, ok := s.cache[uid]; ok && now.Before(entry.expiresAt) {
		s.mu.Unlock()
		return entry.tier
	}
	s.mu.Unlock()

	tier, err := s.fetchTier(ctx, uid)
	if err != nil {
		// fail-open: a pay-service outage caps users at the free tier instead of
		// failing every execution.
		slog.Warn("[QUOTA] membership lookup failed, falling back to free", "uid", uid, "err", err)
		tier = TierFree
	}
	ttl := time.Duration(s.cfg.Quota.AppPay.CacheTTLMS) * time.Millisecond
	if ttl <= 0 {
		ttl = time.Minute
	}
	s.mu.Lock()
	if len(s.cache) > 100000 {
		s.cache = make(map[int64]tierCacheEntry)
	}
	s.cache[uid] = tierCacheEntry{tier: tier, expiresAt: now.Add(ttl)}
	s.mu.Unlock()
	return tier
}

// fetchTier calls app-pay /internal/pay/membership/{uid}.
func (s *QuotaService) fetchTier(ctx context.Context, uid int64) (Tier, error) {
	url := strings.TrimRight(s.cfg.Quota.AppPay.BaseURL, "/") + "/membership/" + strconv.FormatInt(uid, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return TierFree, err
	}
	if key := strings.TrimSpace(s.cfg.Quota.AppPay.APIKey); key != "" {
		req.Header.Set("apikey", key)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return TierFree, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return TierFree, fmt.Errorf("membership http %d: %.200s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var view struct {
		Active bool    `json:"active"`
		Tier   *string `json:"tier"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&view); err != nil {
		return TierFree, err
	}
	if !view.Active {
		return TierFree, nil
	}
	raw := ""
	if view.Tier != nil {
		raw = *view.Tier
	}
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "SVIP":
		return TierSVIP, nil
	case "VIP":
		return TierVIP, nil
	default:
		return TierFree, nil
	}
}

// CheckExecution enforces the daily execution-count and CPU-seconds quotas.
func (s *QuotaService) CheckExecution(ctx context.Context, uid int64) error {
	if !s.cfg.Quota.Enabled {
		return nil
	}
	now := s.now()
	tier := s.TierFor(ctx, uid)
	day := s.Day(now)
	usage, err := s.usage.GetUsage(ctx, uid, day)
	if err != nil {
		// Availability-first: a ledger read failure must not block execution.
		slog.Warn("[QUOTA] usage read failed, skipping daily checks", "uid", uid, "err", err)
		return nil
	}
	if limit := s.Limit(config.QuotaAcademicRun, tier); limit > 0 && usage.Executions >= limit {
		return &QuotaExceededError{Kind: config.QuotaAcademicRun, Tier: string(tier), Limit: limit, Used: usage.Executions, Requested: 1, ResetAt: s.ResetAt(now)}
	}
	if limit := s.Limit(config.QuotaCPUSeconds, tier); limit > 0 {
		usedSeconds := usage.CPUMillis / 1000
		if usedSeconds >= limit {
			return &QuotaExceededError{Kind: config.QuotaCPUSeconds, Tier: string(tier), Limit: limit, Used: usedSeconds, ResetAt: s.ResetAt(now)}
		}
	}
	return nil
}

// CheckArtifact enforces the daily artifact-byte quota before persisting
// artifact metadata.
func (s *QuotaService) CheckArtifact(ctx context.Context, uid, addBytes int64) error {
	if !s.cfg.Quota.Enabled || addBytes <= 0 {
		return nil
	}
	now := s.now()
	tier := s.TierFor(ctx, uid)
	usage, err := s.usage.GetUsage(ctx, uid, s.Day(now))
	if err != nil {
		slog.Warn("[QUOTA] usage read failed, skipping artifact check", "uid", uid, "err", err)
		return nil
	}
	limit := s.Limit(config.QuotaArtifactBytes, tier)
	if limit > 0 && usage.ArtifactBytes+addBytes > limit {
		return &QuotaExceededError{Kind: config.QuotaArtifactBytes, Tier: string(tier), Limit: limit, Used: usage.ArtifactBytes, Requested: addBytes, ResetAt: s.ResetAt(now)}
	}
	return nil
}

// Usage returns today's ledger row for the uid.
func (s *QuotaService) Usage(ctx context.Context, uid int64) (model.SandboxUsageDaily, error) {
	return s.usage.GetUsage(ctx, uid, s.Day(s.now()))
}
