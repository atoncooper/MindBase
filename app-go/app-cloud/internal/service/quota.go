package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/cache"
	"app-cloud/internal/metrics"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// 会员态缓存加固参数（对齐 app-ts/src/utils/membership.ts 的消费侧策略）：
//   - TTL ±15% 抖动：错峰过期，避免整批用户同时回源（缓存雪崩）；
//   - 失败结果短缓存（10s）：支付故障期间不每个请求都回源（缓存击穿），
//     命中时返回 free + 缓存的错误（fail-closed 语义不变）；
//   - 容量上限 10 万：超限先清过期条目，仍超再按比例淘汰一部分，
//     不整体重建 map（避免瞬间把所有用户打回回源）。
const (
	membershipTTLJitterRatio = 0.15
	// defaultMembershipCacheMaxEntries 是进程内档位缓存的默认条数上限。
	defaultMembershipCacheMaxEntries = 100_000
)

// MembershipCacheMaxEntries 是进程内档位缓存容量上限（单测可调小，默认 10 万）。
var MembershipCacheMaxEntries = defaultMembershipCacheMaxEntries

// MembershipFailureCacheTTL 是失败回源结果的短缓存窗口（单测可调小，默认 10s）。
var MembershipFailureCacheTTL = 10 * time.Second

// QuotaService — per-user storage quota, tier sourced from app-pay
// (/internal/pay/membership/{uid} via APISIX key-auth, 60s in-process cache).
// Unreachable membership → fail-closed to the free tier (never oversell
// capacity on a pay-service outage).
type QuotaService struct {
	cfg     *config.Config
	db      *gorm.DB
	repo    *repo.FileRepo
	pending *PendingUploads

	tierCache cache.LoadingCache[int64, string]
	http      *http.Client
}

type membershipView struct {
	UID  int64   `json:"uid"`
	Tier *string `json:"tier"`
	// Active 期望 bool，但容忍 Java LocalDateTime 无时区后缀的 expireAt：
	// 配额逻辑只用 tier/active，expireAt 用宽松的 RawMessage 接住即可。
	Active   bool            `json:"active"`
	ExpireAt json.RawMessage `json:"expireAt"`
}

func NewQuotaService(cfg *config.Config, db *gorm.DB, pending *PendingUploads,
	tierCache cache.LoadingCache[int64, string]) *QuotaService {
	if tierCache == nil {
		panic("service: quota tier cache is required")
	}
	return &QuotaService{
		cfg:       cfg,
		db:        db,
		repo:      repo.NewFileRepo(),
		pending:   pending,
		tierCache: tierCache,
		http:      &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	}
}

// TierFor returns the membership tier for uid ("free" when inactive/unknown).
//
// The cache contract (implemented by infra/cache/local today, optionally
// infra/cache/redis later) owns the L1 storage, TTL and per-key single-flight.
// The service owns only the domain rules: TTL jitter, failure TTL, fail-closed
// normalization and app-pay lookup.
func (s *QuotaService) TierFor(ctx context.Context, uid int64) (string, error) {
	return s.tierCache.GetOrLoad(ctx, uid, s.membershipTTL(), MembershipFailureCacheTTL,
		func(ctx context.Context, key int64) (string, error) {
			view, err := s.fetchMembership(ctx, key)
			if err != nil {
				// fail-closed: keep serving with the free tier quota rather than
				// blocking uploads on a pay-service outage. The loader value is
				// retained in the cache so short-TTL failure hits return free too.
				return "free", fmt.Errorf("membership lookup failed (fail-closed to free): %w", err)
			}
			return s.tierOrDefault(deref(view.Tier), view.Active), nil
		})
}

// membershipTTL 返回本次成功结果的缓存 TTL（config TTL × ±15% 抖动）。
// 配置 TTL <= 0 时保持原语义（立即过期，等于不缓存权威结果）。
func (s *QuotaService) membershipTTL() time.Duration {
	base := time.Duration(s.cfg.Quota.MembershipCacheTTL) * time.Second
	if base <= 0 {
		return 0
	}
	return MembershipCacheTTLWithJitter(base)
}

// MembershipCacheSize 返回当前缓存的会员档位条目数（可观测性 / 单测用）。
func (s *QuotaService) MembershipCacheSize() int {
	return s.tierCache.Len()
}

// MembershipCacheTTLWithJitter 返回带 ±15% 抖动的成功结果缓存 TTL。
// 导出以便单测断言抖动边界；生产代码只经 QuotaService 使用。
func MembershipCacheTTLWithJitter(base time.Duration) time.Duration {
	if base <= 0 {
		return 0
	}
	factor := 1 + membershipTTLJitterRatio*(2*rand.Float64()-1)
	return time.Duration(float64(base) * factor)
}

func (s *QuotaService) tierOrDefault(tier string, active bool) string {
	if !active {
		return "free"
	}
	switch strings.ToUpper(strings.TrimSpace(tier)) {
	case "PROMAX":
		return "promax"
	case "SVIP":
		return "svip"
	case "VIP":
		return "vip"
	default:
		return "free"
	}
}

func (s *QuotaService) fetchMembership(ctx context.Context, uid int64) (*membershipView, error) {
	url := strings.TrimRight(s.cfg.Quota.MembershipBaseURL, "/") + "/membership/" + strconv.FormatInt(uid, 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", s.cfg.Quota.MembershipAPIKey)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("membership http %d: %.200s", resp.StatusCode, string(body))
	}
	view := &membershipView{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(view); err != nil {
		return nil, err
	}
	return view, nil
}

// QuotaFor returns the byte quota for the user's tier.
func (s *QuotaService) QuotaFor(ctx context.Context, uid int64) (int64, string, error) {
	tier, err := s.TierFor(ctx, uid)
	if err != nil {
		return s.cfg.Quota.Free, "free", err
	}
	switch tier {
	case "promax":
		return s.cfg.Quota.PROMAX, tier, nil
	case "svip":
		return s.cfg.Quota.SVIP, tier, nil
	case "vip":
		return s.cfg.Quota.VIP, tier, nil
	default:
		return s.cfg.Quota.Free, tier, nil
	}
}

// Usage returns (usedBytes, quotaBytes, tier, pendingBytes) for the user.
// pendingBytes = in-flight uploads registered by the init endpoint — they
// consume the quota before the cloud_files row exists.
func (s *QuotaService) Usage(ctx context.Context, uid int64) (int64, int64, string, int64, error) {
	quota, tier, err := s.QuotaFor(ctx, uid)
	if err != nil {
		return 0, quota, tier, 0, err
	}
	used, err := s.repo.UsedBytes(s.db, uid)
	if err != nil {
		return 0, quota, tier, 0, err
	}
	pending := s.pending.Sum(ctx, uid)
	return used, quota, tier, pending, nil
}

// ReserveUpload asserts that adding fileSize stays within the user's quota
// AND registers the in-flight upload atomically (one Redis Lua round-trip;
// see PendingUploads.Reserve). Membership lookup failure degrades to the
// FREE tier quota (fail-closed on tier, but never a hard outage block — a
// pay-service incident must not stop regular uploads; it only caps capacity
// at the free tier). Redis unavailability degrades to the legacy non-atomic
// check: same availability as before the ledger existed, race window too.
func (s *QuotaService) ReserveUpload(ctx context.Context, uid int64, uploadUUID string, fileSize int64) error {
	quota, _, _ := s.QuotaFor(ctx, uid) // QuotaFor already falls back to free
	used, err := s.repo.UsedBytes(s.db, uid)
	if err != nil {
		return fmt.Errorf("usage query failed: %w", err)
	}
	status, pending, err := s.pending.Reserve(ctx, uid, uploadUUID, fileSize, quota, used, s.cfg.Upload.MaxConcurrentPerUser)
	if err != nil {
		// Legacy path (non-atomic): used + fileSize only. In-flight uploads
		// already registered remain counted via their own session lifecycle.
		if used+fileSize > quota {
			metrics.QuotaReserve.WithLabelValues("legacy_exceeded").Inc()
			return &QuotaExceededError{Used: used, Quota: quota, Requested: fileSize}
		}
		metrics.QuotaReserve.WithLabelValues("legacy_ok").Inc()
		return nil
	}
	if status == 2 {
		metrics.QuotaReserve.WithLabelValues("concurrency_exceeded").Inc()
		return ErrUploadConcurrency
	}
	if status != 1 {
		metrics.QuotaReserve.WithLabelValues("exceeded").Inc()
		return &QuotaExceededError{Used: used + pending, Quota: quota, Requested: fileSize}
	}
	// Post-reserve recheck: `used` was snapshotted BEFORE the Lua eval. A
	// concurrent complete landing in that gap moves bytes from the Redis
	// ledger into MySQL (used grows, pending shrinks), so the stale snapshot
	// under-counted and the reservation could overshoot the quota. Completions
	// only ever INFLATE the live total (DB row is created before the ledger
	// entry is removed), so a fresh re-read plus the live ledger sum is a safe
	// upper bound: over quota → release this reservation and reject.
	used2, rerr := s.repo.UsedBytes(s.db, uid)
	if rerr != nil {
		// Availability-first: a recheck infrastructure failure must not fail
		// the upload — keep the reservation (pre-recheck semantics).
		slog.Warn("[CLOUD_QUOTA] post-reserve recheck skipped (usage query failed)", "uid", uid, "err", rerr)
		metrics.QuotaRecheckSkipped.Inc()
		return nil
	}
	pending2 := s.pending.Sum(ctx, uid) // includes this reservation
	if used2+pending2 > quota {
		s.pending.Remove(ctx, uid, uploadUUID)
		metrics.QuotaReserve.WithLabelValues("recheck_rejected").Inc()
		return &QuotaExceededError{Used: used2 + pending2, Quota: quota, Requested: fileSize}
	}
	metrics.QuotaReserve.WithLabelValues("ok").Inc()
	return nil
}

// QuotaExceededError maps to HTTP 413 (payload too large) at the router.
type QuotaExceededError struct {
	Used      int64
	Quota     int64
	Requested int64
}

func (e *QuotaExceededError) Error() string {
	return fmt.Sprintf("存储空间不足：已用 %s / 配额 %s，本次需要 %s",
		formatBytes(e.Used), formatBytes(e.Quota), formatBytes(e.Requested))
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return strconv.FormatInt(b, 10) + " B"
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// ErrUploadConcurrency maps to HTTP 429 (too many in-flight uploads for one uid).
var ErrUploadConcurrency = errors.New("too many concurrent uploads; retry later")
