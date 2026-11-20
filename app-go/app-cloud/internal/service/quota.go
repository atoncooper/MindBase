package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-cloud/internal/config"
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
	membershipEvictRatioDiv  = 10
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

	mu    sync.Mutex
	cache map[int64]quotaCacheEntry
	// flights 是 per-uid 的手动单飞表：同 uid 并发 miss 共用一个回源结果。
	flights map[int64]*membershipFlight
	http    *http.Client
}

type quotaCacheEntry struct {
	tier      string
	active    bool
	expiresAt time.Time
	// err 非空表示这是一次失败回源的结果：短 TTL 缓存，命中时直接返回
	// free + 该错误（fail-closed），不再回源。
	err error
}

// membershipFlight 是一次进行中的回源：leader 回源，等待者 <-done 后读取结果。
// 字段在 close(done) 之前写入，channel 关闭建立 happens-before，无需额外锁。
type membershipFlight struct {
	done chan struct{}
	tier string
	err  error
}

type membershipView struct {
	UID  int64   `json:"uid"`
	Tier *string `json:"tier"`
	// Active 期望 bool，但容忍 Java LocalDateTime 无时区后缀的 expireAt：
	// 配额逻辑只用 tier/active，expireAt 用宽松的 RawMessage 接住即可。
	Active   bool            `json:"active"`
	ExpireAt json.RawMessage `json:"expireAt"`
}

func NewQuotaService(cfg *config.Config, db *gorm.DB, pending *PendingUploads) *QuotaService {
	return &QuotaService{
		cfg:     cfg,
		db:      db,
		repo:    repo.NewFileRepo(),
		pending: pending,
		cache:   make(map[int64]quotaCacheEntry),
		flights: make(map[int64]*membershipFlight),
		http:    &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	}
}

// TierFor returns the membership tier for uid ("free" when inactive/unknown).
//
// 缓存加固（对齐 app-ts/src/utils/membership.ts 的消费侧策略）：
//   - per-uid 手动单飞：同一 uid 的并发 miss 只回源一次，等待者共享结果；
//   - TTL ±15% 抖动：错峰过期，避免整批用户同时回源（缓存雪崩）；
//   - 失败结果短 TTL 缓存：命中时返回 free + 缓存的错误，不再回源（缓存击穿
//     保护）；支付服务恢复后最快一个失败 TTL 回到权威档位；
//   - 容量上限：超限先清过期条目，仍超再按比例淘汰，不整体重建 map。
//
// fail-closed 语义不变：回源失败仍返回 free + 错误，绝不因支付故障放量。
func (s *QuotaService) TierFor(ctx context.Context, uid int64) (string, error) {
	now := time.Now()
	s.mu.Lock()
	if e, ok := s.cache[uid]; ok && now.Before(e.expiresAt) {
		s.mu.Unlock()
		if e.err != nil {
			return "free", e.err
		}
		return s.tierOrDefault(e), nil
	}
	// 单飞：已有同 uid 的回源在进行 → 等它，不再发第二个请求。
	if f, ok := s.flights[uid]; ok {
		s.mu.Unlock()
		<-f.done
		return f.tier, f.err
	}
	if s.flights == nil {
		s.flights = make(map[int64]*membershipFlight)
	}
	flight := &membershipFlight{done: make(chan struct{})}
	s.flights[uid] = flight
	s.mu.Unlock()

	tier, lookupErr := s.lookupAndCache(ctx, uid)

	// 先写单飞结果、再关 channel（close 建立 happens-before，等待者可见）。
	flight.tier, flight.err = tier, lookupErr
	s.mu.Lock()
	delete(s.flights, uid)
	s.mu.Unlock()
	close(flight.done)
	return tier, lookupErr
}

// lookupAndCache 执行一次回源并写缓存（成功长 TTL / 失败短 TTL），返回对外结果。
func (s *QuotaService) lookupAndCache(ctx context.Context, uid int64) (string, error) {
	view, err := s.fetchMembership(ctx, uid)
	now := time.Now()
	if err != nil {
		// fail-closed: keep serving with the free tier quota rather than
		// blocking uploads on a pay-service outage.
		lookupErr := fmt.Errorf("membership lookup failed (fail-closed to free): %w", err)
		s.storeLocked(uid, quotaCacheEntry{expiresAt: now.Add(MembershipFailureCacheTTL), err: lookupErr})
		return "free", lookupErr
	}
	entry := quotaCacheEntry{
		tier:      deref(view.Tier),
		active:    view.Active,
		expiresAt: now.Add(s.membershipTTL()),
	}
	s.storeLocked(uid, entry)
	return s.tierOrDefault(entry), nil
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

// storeLocked 写缓存前先做容量清理，保证写入后不超过容量上限。
// 覆盖已有 uid 不增长 map，无需腾位置（避免误淘汰无关条目）。
func (s *QuotaService) storeLocked(uid int64, entry quotaCacheEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.cache[uid]; !exists {
		s.evictLocked(time.Now())
	}
	s.cache[uid] = entry
}

// evictLocked 保证写入新条目前缓存有余量：
//  1. 先删过期条目（尽量保留仍在 TTL 内的档位）；
//  2. 仍超限时按约 1/10 的比例淘汰一部分（Go map 迭代顺序随机 → 近似随机淘汰）；
//     绝不整体重建 map，避免瞬间把所有用户打回回源（缓存击穿）。
func (s *QuotaService) evictLocked(now time.Time) {
	limit := MembershipCacheMaxEntries
	if limit <= 0 {
		limit = defaultMembershipCacheMaxEntries
	}
	if len(s.cache) < limit {
		return
	}
	for uid, e := range s.cache {
		if !now.Before(e.expiresAt) {
			delete(s.cache, uid)
		}
	}
	if len(s.cache) < limit {
		return
	}
	remove := len(s.cache) / membershipEvictRatioDiv
	if remove < 1 {
		remove = 1
	}
	target := len(s.cache) - remove
	if target > limit-1 {
		target = limit - 1
	}
	for uid := range s.cache {
		if len(s.cache) <= target {
			break
		}
		delete(s.cache, uid)
	}
}

// MembershipCacheSize 返回当前缓存的会员档位条目数（可观测性 / 单测用）。
func (s *QuotaService) MembershipCacheSize() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cache)
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

func (s *QuotaService) tierOrDefault(e quotaCacheEntry) string {
	if !e.active {
		return "free"
	}
	switch strings.ToUpper(strings.TrimSpace(e.tier)) {
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
	ok, pending, err := s.pending.Reserve(ctx, uid, uploadUUID, fileSize, quota, used)
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
	if !ok {
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
