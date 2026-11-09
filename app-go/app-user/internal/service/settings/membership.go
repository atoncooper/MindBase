// Membership gate client for the Coding Plan (settings domain).
// Moved from internal/service/auth together with the Coding Plan feature: the
// app_pay config still comes from the auth config section (config.AppPayConfig)
// and main injects it into the settings service.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-user/internal/config"
)

// Membership tiers consumed by the Coding Plan gate.
const (
	TierFree = "free"
	TierVIP  = "vip"
	TierSVIP = "svip"
)

// membershipCacheTTL is the short in-process cache for app-pay membership
// lookups (60s, matching app-cloud/app-ts): a purchase/unpurchase shows up
// within one TTL without hammering the pay service on every account-page call.
const membershipCacheTTL = 60 * time.Second

// MembershipClient resolves a user's membership tier from app-pay
// GET /internal/pay/membership/{uid} through APISIX key-auth.
//
// Fail-closed by contract: transport / non-200 / malformed responses return an
// error (callers must deny the operation), never a silent "free" downgrade.
type MembershipClient struct {
	baseURL string
	apiKey  string
	http    *http.Client

	mu    sync.Mutex
	cache map[int64]membershipCacheEntry
}

type membershipCacheEntry struct {
	tier      string
	expiresAt time.Time
}

// membershipReply is the subset of app-pay's response the gate needs. expireAt
// is intentionally not decoded strictly (Java LocalDateTime has no zone
// suffix); the authoritative gate is active + tier.
type membershipReply struct {
	UID    int64   `json:"uid"`
	Tier   *string `json:"tier"`
	Active bool    `json:"active"`
}

// NewMembershipClient builds the client from the app_pay config section.
// An empty base URL falls back to the APISIX origin used in compose.
func NewMembershipClient(cfg config.AppPayConfig) *MembershipClient {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = "http://apisix:9080"
	}
	return &MembershipClient{
		baseURL: base,
		apiKey:  strings.TrimSpace(cfg.Key),
		http: &http.Client{
			Timeout:   5 * time.Second,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		},
		cache: make(map[int64]membershipCacheEntry),
	}
}

// Tier returns "free" | "vip" | "svip". Errors are fail-closed: the caller
// must reject the request (never assume free and proceed).
func (c *MembershipClient) Tier(ctx context.Context, uid int64) (string, error) {
	if uid <= 0 {
		return "", errors.New("invalid uid")
	}
	c.mu.Lock()
	if entry, ok := c.cache[uid]; ok && time.Now().Before(entry.expiresAt) {
		tier := entry.tier
		c.mu.Unlock()
		return tier, nil
	}
	c.mu.Unlock()

	reply, err := c.fetch(ctx, uid)
	if err != nil {
		return "", err
	}
	tier := membershipTier(reply)
	c.mu.Lock()
	if len(c.cache) > 100_000 {
		c.cache = make(map[int64]membershipCacheEntry)
	}
	c.cache[uid] = membershipCacheEntry{tier: tier, expiresAt: time.Now().Add(membershipCacheTTL)}
	c.mu.Unlock()
	return tier, nil
}

// Invalidate drops one cached tier (used by tests / future admin hooks).
func (c *MembershipClient) Invalidate(uid int64) {
	c.mu.Lock()
	delete(c.cache, uid)
	c.mu.Unlock()
}

func membershipTier(reply *membershipReply) string {
	if reply == nil || !reply.Active || reply.Tier == nil {
		return TierFree
	}
	switch strings.ToUpper(strings.TrimSpace(*reply.Tier)) {
	case "VIP":
		return TierVIP
	case "SVIP":
		return TierSVIP
	default:
		return TierFree
	}
}

func (c *MembershipClient) membershipURL(uid int64) string {
	// Tolerate both documented shapes: the gateway origin (default
	// http://apisix:9080) and a base already pointing at /internal/pay.
	base := c.baseURL
	if strings.HasSuffix(base, "/internal/pay") {
		return base + "/membership/" + strconv.FormatInt(uid, 10)
	}
	return base + "/internal/pay/membership/" + strconv.FormatInt(uid, 10)
}

func (c *MembershipClient) fetch(ctx context.Context, uid int64) (*membershipReply, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.membershipURL(uid), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.apiKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Status only: the response body may contain operator detail and must
		// not end up in user-facing errors or logs.
		return nil, fmt.Errorf("membership lookup http %d", resp.StatusCode)
	}
	reply := &membershipReply{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(reply); err != nil {
		return nil, fmt.Errorf("decode membership: %w", err)
	}
	return reply, nil
}
