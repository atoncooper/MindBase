package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

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
	http  *http.Client
}

type quotaCacheEntry struct {
	tier      string
	active    bool
	expiresAt time.Time
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
		http:    &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	}
}

// TierFor returns the membership tier for uid ("free" when inactive/unknown).
func (s *QuotaService) TierFor(ctx context.Context, uid int64) (string, error) {
	s.mu.Lock()
	if e, ok := s.cache[uid]; ok && time.Now().Before(e.expiresAt) {
		s.mu.Unlock()
		return s.tierOrDefault(e), nil
	}
	s.mu.Unlock()

	view, err := s.fetchMembership(ctx, uid)
	if err != nil {
		// fail-closed: keep serving with the free tier quota rather than
		// blocking uploads on a pay-service outage.
		return "free", fmt.Errorf("membership lookup failed (fail-closed to free): %w", err)
	}
	s.mu.Lock()
	if len(s.cache) > 100_000 {
		s.cache = make(map[int64]quotaCacheEntry)
	}
	s.cache[uid] = quotaCacheEntry{
		tier:      deref(view.Tier),
		active:    view.Active,
		expiresAt: time.Now().Add(time.Duration(s.cfg.Quota.MembershipCacheTTL) * time.Second),
	}
	s.mu.Unlock()
	return s.tierOrDefault(quotaCacheEntry{tier: deref(view.Tier), active: view.Active}), nil
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

// CheckUpload asserts that adding fileSize stays within the user's quota.
// Membership lookup failure degrades to the FREE tier quota (fail-closed on
// tier, but never a hard outage block — a pay-service incident must not stop
// regular uploads; it only caps capacity at the free tier).
func (s *QuotaService) CheckUpload(ctx context.Context, uid int64, fileSize int64) error {
	quota, _, _ := s.QuotaFor(ctx, uid) // QuotaFor already falls back to free
	used, err := s.repo.UsedBytes(s.db, uid)
	if err != nil {
		return fmt.Errorf("usage query failed: %w", err)
	}
	// In-flight uploads count too — otherwise N parallel inits each pass
	// the check and together exceed the quota.
	pending := s.pending.Sum(ctx, uid)
	if used+pending+fileSize > quota {
		return &QuotaExceededError{Used: used + pending, Quota: quota, Requested: fileSize}
	}
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
