// Package router: pluggable backing stores for the console's per-process
// state. The default implementations are in-process memory (single instance,
// zero dependencies); webui.session_store=redis swaps in Redis-backed ones so
// sessions, one-time API-key reveals, auth-failure throttles and per-key rate
// counters are shared across instances. Every Redis path is fail-open where
// the semantics allow it (throttles/limits) and degrades to an error where it
// must (session save), matching the app-auth Redis conventions.
package router

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"app-task/internal/config"

	"github.com/redis/go-redis/v9"
)

// throttler tracks per-IP auth failures (shared by the console login and the
// service-key auth gate so the limit cannot be bypassed via either surface).
type throttler interface {
	allow(ip string) bool
	fail(ip string)
	reset(ip string)
}

// keyRateLimiter caps requests per minute per API key.
type keyRateLimiter interface {
	allowRequest(keyID string, ratePerMin int) bool
}

// sessionStore persists browser/API sessions (webuiSession + TTL).
type sessionStore interface {
	save(id string, s webuiSession, ttl time.Duration) error
	load(id string) (webuiSession, bool)
	delete(id string)
}

// revealStore holds freshly generated API-key plaintexts for exactly one read.
type revealStore interface {
	put(plaintext string, ttl time.Duration) string
	take(token string, ttl time.Duration) (string, bool)
}

// ── memory implementations (default, single instance) ────────────────

// memoryThrottler is the in-process per-IP failure throttle.
type memoryThrottler struct {
	mu         sync.Mutex
	fails      map[string]int
	window     time.Time
	maxFails   int
	failWindow time.Duration
}

func newMemoryThrottler(maxFails int, failWindow time.Duration) *memoryThrottler {
	return &memoryThrottler{
		fails:      make(map[string]int),
		window:     time.Now(),
		maxFails:   maxFails,
		failWindow: failWindow,
	}
}

func (m *memoryThrottler) allow(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rollWindowLocked()
	return m.fails[ip] < m.maxFails
}

func (m *memoryThrottler) fail(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rollWindowLocked()
	m.fails[ip]++
}

func (m *memoryThrottler) reset(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.fails, ip)
}

func (m *memoryThrottler) rollWindowLocked() {
	now := time.Now()
	if now.Sub(m.window) >= m.failWindow {
		m.fails = make(map[string]int)
		m.window = now
	}
}

// memoryLimiter is the in-process per-key fixed-minute rate counter.
type memoryLimiter struct {
	mu    sync.Mutex
	rates map[string]*reqWindow
}

type reqWindow struct {
	minute int64
	count  int
}

func newMemoryLimiter() *memoryLimiter {
	return &memoryLimiter{rates: make(map[string]*reqWindow)}
}

func (m *memoryLimiter) allowRequest(keyID string, ratePerMin int) bool {
	if ratePerMin <= 0 {
		return true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	minute := time.Now().Unix() / 60
	w := m.rates[keyID]
	if w == nil || w.minute != minute {
		m.rates[keyID] = &reqWindow{minute: minute, count: 1}
		return true
	}
	w.count++
	return w.count <= ratePerMin
}

// memorySessionStore is the in-process session table.
type memorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]webuiSession
}

func newMemorySessionStore() *memorySessionStore {
	return &memorySessionStore{sessions: make(map[string]webuiSession)}
}

func (m *memorySessionStore) save(id string, s webuiSession, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[id] = s
	return nil
}

func (m *memorySessionStore) load(id string) (webuiSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || time.Now().After(s.Expiry) {
		delete(m.sessions, id)
		return webuiSession{}, false
	}
	return s, true
}

func (m *memorySessionStore) delete(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

// memoryRevealStore holds one-time key plaintexts in process memory.
type memoryRevealStore struct {
	mu      sync.Mutex
	reveals map[string]revealEntry
}

type revealEntry struct {
	plaintext string
	expiry    time.Time
}

func newMemoryRevealStore() *memoryRevealStore {
	return &memoryRevealStore{reveals: make(map[string]revealEntry)}
}

func (m *memoryRevealStore) put(plaintext string, ttl time.Duration) string {
	tok := newKeyID()
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, e := range m.reveals { // opportunistic GC of expired entries
		if time.Now().After(e.expiry) {
			delete(m.reveals, id)
		}
	}
	m.reveals[tok] = revealEntry{plaintext: plaintext, expiry: time.Now().Add(ttl)}
	return tok
}

func (m *memoryRevealStore) take(token string, _ time.Duration) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.reveals[token]
	if !ok {
		return "", false
	}
	delete(m.reveals, token)
	if time.Now().After(e.expiry) {
		return "", false
	}
	return e.plaintext, true
}

// ── redis implementations (webui.session_store=redis) ────────────────

const redisKeyPrefix = "mind-base:apptask:"

// newRedisClient builds the shared client: URL carries address/auth/TLS
// (rediss://); the optional pool/timeout overrides from redis.* config are
// applied on top of go-redis defaults.
func newRedisClient(rc config.RedisConfig) (*redis.Client, error) {
	opts, err := redis.ParseURL(rc.URL)
	if err != nil {
		return nil, err
	}
	if rc.PoolSize > 0 {
		opts.PoolSize = rc.PoolSize
	}
	if rc.MinIdleConns > 0 {
		opts.MinIdleConns = rc.MinIdleConns
	}
	if rc.DialTimeoutSeconds > 0 {
		opts.DialTimeout = time.Duration(rc.DialTimeoutSeconds) * time.Second
	}
	if rc.ReadTimeoutSeconds > 0 {
		opts.ReadTimeout = time.Duration(rc.ReadTimeoutSeconds) * time.Second
	}
	if rc.WriteTimeoutSeconds > 0 {
		opts.WriteTimeout = time.Duration(rc.WriteTimeoutSeconds) * time.Second
	}
	if rc.MaxRetries > 0 {
		opts.MaxRetries = rc.MaxRetries
	}
	return redis.NewClient(opts), nil
}

type redisBacked struct{ rdb *redis.Client }

// redisThrottler shares the per-IP failure throttle across instances. Fail-open:
// a Redis outage must not lock operators out of the console.
type redisThrottler struct {
	redisBacked
	maxFails   int
	failWindow time.Duration
}

func newRedisThrottler(rdb *redis.Client, maxFails int, failWindow time.Duration) *redisThrottler {
	return &redisThrottler{
		redisBacked: redisBacked{rdb: rdb},
		maxFails:    maxFails,
		failWindow:  failWindow,
	}
}

func (r *redisThrottler) key(ip string) string {
	return redisKeyPrefix + "fail:" + ip
}

func (r *redisThrottler) allow(ip string) bool {
	n, err := r.rdb.Get(context.Background(), r.key(ip)).Int()
	if err != nil && err != redis.Nil {
		slog.Warn("[WEBUI] redis throttle check failed, failing open", "err", err)
		return true
	}
	return n < r.maxFails
}

func (r *redisThrottler) fail(ip string) {
	ctx := context.Background()
	n, err := r.rdb.Incr(ctx, r.key(ip)).Result()
	if err != nil {
		slog.Warn("[WEBUI] redis throttle increment failed", "err", err)
		return
	}
	if n == 1 {
		r.rdb.Expire(ctx, r.key(ip), r.failWindow)
	}
}

func (r *redisThrottler) reset(ip string) {
	r.rdb.Del(context.Background(), r.key(ip))
}

// redisLimiter shares the per-key rate counters across instances. Fail-open.
type redisLimiter struct{ redisBacked }

func newRedisLimiter(rdb *redis.Client) *redisLimiter {
	return &redisLimiter{redisBacked{rdb: rdb}}
}

func (r *redisLimiter) allowRequest(keyID string, ratePerMin int) bool {
	if ratePerMin <= 0 {
		return true
	}
	ctx := context.Background()
	minute := time.Now().Unix() / 60
	key := redisKeyPrefix + "rate:" + keyID + ":" + strconv.FormatInt(minute, 10)
	n, err := r.rdb.Incr(ctx, key).Result()
	if err != nil {
		slog.Warn("[WEBUI] redis rate increment failed, failing open", "err", err)
		return true
	}
	if n == 1 {
		r.rdb.Expire(ctx, key, 65*time.Second)
	}
	return n <= int64(ratePerMin)
}

// redisSessionStore persists sessions in Redis with the login TTL.
type redisSessionStore struct{ redisBacked }

func newRedisSessionStore(rdb *redis.Client) *redisSessionStore {
	return &redisSessionStore{redisBacked{rdb: rdb}}
}

func (r *redisSessionStore) key(id string) string {
	return redisKeyPrefix + "sess:" + id
}

func (r *redisSessionStore) save(id string, s webuiSession, ttl time.Duration) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return r.rdb.Set(context.Background(), r.key(id), b, ttl).Err()
}

func (r *redisSessionStore) load(id string) (webuiSession, bool) {
	b, err := r.rdb.Get(context.Background(), r.key(id)).Bytes()
	if err != nil {
		return webuiSession{}, false
	}
	var s webuiSession
	if err := json.Unmarshal(b, &s); err != nil {
		return webuiSession{}, false
	}
	if time.Now().After(s.Expiry) {
		r.delete(id)
		return webuiSession{}, false
	}
	return s, true
}

func (r *redisSessionStore) delete(id string) {
	r.rdb.Del(context.Background(), r.key(id))
}

// redisRevealStore holds one-time key plaintexts in Redis (GETDEL = single
// read even across instances).
type redisRevealStore struct{ redisBacked }

func newRedisRevealStore(rdb *redis.Client) *redisRevealStore {
	return &redisRevealStore{redisBacked{rdb: rdb}}
}

func (r *redisRevealStore) put(plaintext string, ttl time.Duration) string {
	tok := newKeyID()
	r.rdb.Set(context.Background(), redisKeyPrefix+"reveal:"+tok, plaintext, ttl)
	return tok
}

func (r *redisRevealStore) take(token string, _ time.Duration) (string, bool) {
	s, err := r.rdb.GetDel(context.Background(), redisKeyPrefix+"reveal:"+token).Result()
	if err != nil {
		return "", false
	}
	return s, true
}
