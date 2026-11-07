package cache

import (
	"context"
	"encoding/json"
	"log/slog"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// AuthzCache caches the two hot authorization facts that would otherwise
// require a MySQL query on every gateway forward-auth request:
//   - the user's active roles (X-Roles header)
//   - the account status / soft-delete flag (disabled-account enforcement)
//
// L1 is in-process, L2 is Redis. TTL is intentionally short (60s default) so
// role changes or a manual ban take effect quickly even without explicit
// invalidation; GrantRole/SetStatus paths also delete the key immediately.
type AuthzCache struct {
	ns  string
	ttl time.Duration

	mu      sync.RWMutex
	roles   map[int64]authzRolesEntry
	status  map[int64]authzStatusEntry
	rdb     redis.UniversalClient
	redisOK bool
}

type authzRolesEntry struct {
	roles   []string
	expires time.Time
}

type authzStatusEntry struct {
	Status  string    `json:"status"`
	Deleted bool      `json:"deleted"`
	Expires time.Time `json:"expires,omitempty"`
}

// NewAuthz builds the cache from the token-cache namespace. "appauth:token:"
// becomes the base for "appauth:roles:" / "appauth:status:".
func NewAuthz(rdb redis.UniversalClient, tokenNS string, ttl time.Duration) *AuthzCache {
	base := tokenNS
	if i := strings.LastIndex(base, "token:"); i >= 0 {
		base = base[:i]
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	return &AuthzCache{
		ns:      base,
		ttl:     ttl,
		roles:   make(map[int64]authzRolesEntry),
		status:  make(map[int64]authzStatusEntry),
		rdb:     rdb,
		redisOK: rdb != nil,
	}
}

func (c *AuthzCache) jitter() time.Duration {
	return time.Duration(float64(c.ttl) * (0.9 + rand.Float64()*0.2))
}

func (c *AuthzCache) rolesKey(uid int64) string { return c.ns + "roles:" + strconv.FormatInt(uid, 10) }
func (c *AuthzCache) statusKey(uid int64) string {
	return c.ns + "status:" + strconv.FormatInt(uid, 10)
}

// GetRoles returns cached active roles for uid.
func (c *AuthzCache) GetRoles(ctx context.Context, uid int64) ([]string, bool) {
	if c == nil || uid <= 0 {
		return nil, false
	}
	now := time.Now()
	c.mu.RLock()
	if e, ok := c.roles[uid]; ok && now.Before(e.expires) {
		roles := append([]string(nil), e.roles...)
		c.mu.RUnlock()
		return roles, true
	}
	c.mu.RUnlock()

	if !c.redisOK {
		return nil, false
	}
	raw, err := c.rdb.Get(ctx, c.rolesKey(uid)).Result()
	if err != nil {
		return nil, false
	}
	var roles []string
	if err := json.Unmarshal([]byte(raw), &roles); err != nil {
		return nil, false
	}
	c.mu.Lock()
	c.roles[uid] = authzRolesEntry{roles: append([]string(nil), roles...), expires: now.Add(c.jitter())}
	c.mu.Unlock()
	return roles, true
}

const authzMaxEntries = 100_000

func (c *AuthzCache) pruneRolesLocked(now time.Time) {
	if len(c.roles) <= authzMaxEntries {
		return
	}
	for k, e := range c.roles {
		if !now.Before(e.expires) {
			delete(c.roles, k)
		}
	}
	for k := range c.roles {
		if len(c.roles) <= authzMaxEntries {
			break
		}
		delete(c.roles, k)
	}
}

func (c *AuthzCache) pruneStatusLocked(now time.Time) {
	if len(c.status) <= authzMaxEntries {
		return
	}
	for k, e := range c.status {
		if !now.Before(e.Expires) {
			delete(c.status, k)
		}
	}
	for k := range c.status {
		if len(c.status) <= authzMaxEntries {
			break
		}
		delete(c.status, k)
	}
}

// SetRoles caches roles (L1 + L2).
func (c *AuthzCache) SetRoles(ctx context.Context, uid int64, roles []string) {
	if c == nil || uid <= 0 {
		return
	}
	if roles == nil {
		roles = []string{}
	}
	now := time.Now()
	c.mu.Lock()
	c.pruneRolesLocked(now)
	c.roles[uid] = authzRolesEntry{roles: append([]string(nil), roles...), expires: now.Add(c.jitter())}
	c.mu.Unlock()

	if c.redisOK {
		if raw, err := json.Marshal(roles); err == nil {
			if err := c.rdb.Set(ctx, c.rolesKey(uid), raw, c.jitter()).Err(); err != nil {
				slog.Warn("[CACHE] redis set roles failed", "err", err)
			}
		}
	}
}

// DeleteRoles drops the role entry (role grant/revoke).
func (c *AuthzCache) DeleteRoles(ctx context.Context, uid int64) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.roles, uid)
	c.mu.Unlock()
	if c.redisOK {
		_ = c.rdb.Del(ctx, c.rolesKey(uid)).Err()
	}
}

// GetStatus returns the cached account status and soft-delete flag.
func (c *AuthzCache) GetStatus(ctx context.Context, uid int64) (status string, deleted bool, ok bool) {
	if c == nil || uid <= 0 {
		return "", false, false
	}
	now := time.Now()
	c.mu.RLock()
	if e, exists := c.status[uid]; exists && now.Before(e.Expires) {
		status, deleted = e.Status, e.Deleted
		c.mu.RUnlock()
		return status, deleted, true
	}
	c.mu.RUnlock()

	if !c.redisOK {
		return "", false, false
	}
	raw, err := c.rdb.Get(ctx, c.statusKey(uid)).Result()
	if err != nil {
		return "", false, false
	}
	var e authzStatusEntry
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		return "", false, false
	}
	c.mu.Lock()
	c.status[uid] = authzStatusEntry{Status: e.Status, Deleted: e.Deleted, Expires: now.Add(c.jitter())}
	c.mu.Unlock()
	return e.Status, e.Deleted, true
}

// SetStatus caches the account status/soft-delete flag (L1 + L2).
func (c *AuthzCache) SetStatus(ctx context.Context, uid int64, status string, deleted bool) {
	if c == nil || uid <= 0 {
		return
	}
	now := time.Now()
	c.mu.Lock()
	c.pruneStatusLocked(now)
	c.status[uid] = authzStatusEntry{Status: status, Deleted: deleted, Expires: now.Add(c.jitter())}
	c.mu.Unlock()

	if c.redisOK {
		raw, err := json.Marshal(authzStatusEntry{Status: status, Deleted: deleted})
		if err == nil {
			if err := c.rdb.Set(ctx, c.statusKey(uid), raw, c.jitter()).Err(); err != nil {
				slog.Warn("[CACHE] redis set status failed", "err", err)
			}
		}
	}
}

// DeleteStatus drops the status entry.
func (c *AuthzCache) DeleteStatus(ctx context.Context, uid int64) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.status, uid)
	c.mu.Unlock()
	if c.redisOK {
		_ = c.rdb.Del(ctx, c.statusKey(uid)).Err()
	}
}
