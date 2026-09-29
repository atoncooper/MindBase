// Package router: API-key authentication for the service surface.
//
// The middleware protects /tasks/*, /scripts* and /internal/* from unauthenticated
// direct access to the app-task port (the gateway's key-auth only guards the
// gateway hop). Accepted credentials, all equivalent:
//   - X-API-Key / apikey / Authorization: Bearer holding a key generated in
//     the console (SHA-256 hash persisted in api_key; plaintext shown once);
//   - bootstrap service keys seeded from env at startup (e.g. the APISIX
//     consumer key, so gateway-routed calls keep working unchanged);
//   - a valid console session cookie / master token (webuiAuthenticator).
//
// Auth failures are throttled per client IP (same policy as the console login
// throttle) and logged.
package router

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
)

const (
	apiKeyBytes     = 32
	apiKeyRevealTTL = 5 * time.Minute
	apiKeyCtxName   = "api_key_name"
)

// Service-scope groups enforced by the middleware. A key's Scopes CSV must
// contain the group required by the request path; empty Scopes = all groups
// (legacy/bootstrap rows before scopes existed).
const (
	scopeTasks    = "tasks"
	scopeScripts  = "scripts"
	scopeInternal = "internal"
)

// requiredScope maps a request path to the scope group it belongs to.
func requiredScope(path string) string {
	switch {
	case strings.HasPrefix(path, "/tasks"):
		return scopeTasks
	case strings.HasPrefix(path, "/scripts"):
		return scopeScripts
	case strings.HasPrefix(path, "/internal"):
		return scopeInternal
	}
	return ""
}

// keyHasScope reports whether the key's scope CSV grants the group. Empty CSV
// grants everything (rows created before scopes existed).
func keyHasScope(scopes, required string) bool {
	if required == "" || scopes == "" {
		return true
	}
	for _, s := range strings.Split(scopes, ",") {
		if strings.TrimSpace(s) == required {
			return true
		}
	}
	return false
}

// keyService holds the auth throttle, the per-key rate limiter and the
// one-time reveal store — in-process memory by default, Redis-backed when
// webui.session_store=redis (see state_stores.go).
type keyService struct {
	throttle throttler
	limiter  keyRateLimiter
	reveals  revealStore
}

func newKeyService(throttle throttler, limiter keyRateLimiter, reveals revealStore) *keyService {
	if throttle == nil {
		throttle = newMemoryThrottler(webuiMaxFails, webuiFailWindow)
	}
	if limiter == nil {
		limiter = newMemoryLimiter()
	}
	if reveals == nil {
		reveals = newMemoryRevealStore()
	}
	return &keyService{throttle: throttle, limiter: limiter, reveals: reveals}
}

// allowRequest enforces the per-key rate cap (requests/minute).
// ratePerMin <= 0 means unlimited.
func (k *keyService) allowRequest(keyID string, ratePerMin int) bool {
	return k.limiter.allowRequest(keyID, ratePerMin)
}

// allow / fail / reset mirror the console login throttle (10 failures per
// minute per client IP, shared by every protected service endpoint).
func (k *keyService) allow(ip string) bool { return k.throttle.allow(ip) }

func (k *keyService) fail(ip string) { k.throttle.fail(ip) }

func (k *keyService) reset(ip string) { k.throttle.reset(ip) }

// ── key generation / hashing ────────────────────────────────────────

// hashAPIKey derives the stored digest of a presented key.
func hashAPIKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// generateAPIKey mints a new credential: plaintext (shown once) + the row to
// persist (hash + display prefix).
func generateAPIKey() (plaintext string, row *model.APIKey, err error) {
	raw := make([]byte, apiKeyBytes)
	if _, err = rand.Read(raw); err != nil {
		return "", nil, err
	}
	plaintext = "at_" + hex.EncodeToString(raw)
	row = &model.APIKey{
		KeyID:     newKeyID(),
		Name:      "pending",
		KeyHash:   hashAPIKey(plaintext),
		KeyPrefix: plaintext[:12] + "…",
		Status:    repo.APIKeyStatusActive,
	}
	return plaintext, row, nil
}

func newKeyID() string {
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return "key_" + hex.EncodeToString(raw)
}

// ── one-time reveal store (PRG-safe key display) ────────────────────

// putReveal stores a freshly generated plaintext under a one-time token; the
// result page reads (and deletes) it once within the TTL.
func (k *keyService) putReveal(plaintext string) string {
	return k.reveals.put(plaintext, apiKeyRevealTTL)
}

func (k *keyService) takeReveal(token string) (string, bool) {
	return k.reveals.take(token, apiKeyRevealTTL)
}

// ── credential extraction / verification ────────────────────────────

// extractAPIKey finds a presented service credential in the three accepted
// header forms. Cookie-based console sessions are NOT a service credential
// here — the console talks to the service surface through /api/* instead.
func extractAPIKey(c *gin.Context) string {
	if v := c.GetHeader("X-API-Key"); v != "" {
		return strings.TrimSpace(v)
	}
	if v := c.GetHeader("apikey"); v != "" {
		return strings.TrimSpace(v)
	}
	if b := c.GetHeader("Authorization"); len(b) > 7 && strings.EqualFold(b[:7], "Bearer ") {
		return strings.TrimSpace(b[7:])
	}
	return ""
}

// verifyAPIKey resolves a presented credential to an active, unexpired row.
func verifyAPIKey(plaintext string) (*model.APIKey, bool) {
	if plaintext == "" {
		return nil, false
	}
	row, err := repo.GetAPIKeyByHash(hashAPIKey(plaintext))
	if err != nil || row == nil {
		return nil, false
	}
	if row.Status != repo.APIKeyStatusActive {
		return nil, false
	}
	if row.ExpiresAt != nil && time.Now().After(*row.ExpiresAt) {
		return nil, false
	}
	return row, true
}

// apiKeyAuthMiddleware gates the service surface. Console sessions are also
// accepted so the embedded console can never be locked out of its own
// service endpoints (belt-and-braces; the console normally uses /api/*).
// consoleAuth may be nil when webui.enabled=false — key auth then stands alone.
func (r *Router) apiKeyAuthMiddleware(keys *keyService) gin.HandlerFunc {
	return func(c *gin.Context) {
		if r.consoleAuth != nil {
			if _, ok := r.consoleAuth.authenticate(r.consoleAuth.extractToken(c)); ok {
				c.Next()
				return
			}
		}

		ip := c.ClientIP()
		if !keys.allow(ip) {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"detail": "too many failed attempts, retry after the cooldown"})
			return
		}
		presented := extractAPIKey(c)
		row, valid := verifyAPIKey(presented)
		if !valid {
			if presented != "" {
				slog.Warn("[APIKEY] rejected service request", "ip", ip, "prefix", presented[:min(10, len(presented))])
			}
			keys.fail(ip)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "unauthorized (valid API key required; generate one in the console)"})
			return
		}

		keys.reset(ip)

		// Scope enforcement: the key must grant the group this path belongs to.
		scope := requiredScope(c.Request.URL.Path)
		if !keyHasScope(row.Scopes, scope) {
			slog.Warn("[APIKEY] scope denied", "key", row.Name, "scope", scope, "ip", ip)
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"detail": "api key lacks required scope: " + scope})
			return
		}

		// Per-key resource control: requests/minute cap.
		if !keys.allowRequest(row.KeyID, row.RatePerMin) {
			slog.Warn("[APIKEY] rate limit exceeded", "key", row.Name, "rate_per_min", row.RatePerMin, "ip", ip)
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"detail": "api key rate limit exceeded"})
			return
		}

		repo.TouchAPIKeyUsed(row.KeyID, row.LastUsedAt)
		c.Set(apiKeyCtxName, row.Name)
		c.Next()
	}
}

// requireBootstrapKeys seeds env-provided service keys (APISIX consumer key
// etc.) into the api_key table so gateway-routed calls pass the middleware
// with no manual setup. Runs once at startup, after DB init.
func requireBootstrapKeys(serviceKeys []string) {
	for i, raw := range serviceKeys {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		name := "bootstrap-service-key"
		if len(serviceKeys) > 1 {
			name = "bootstrap-service-key-" + strconv.Itoa(i+1)
		}
		row := &model.APIKey{
			KeyID:     newKeyID(),
			Name:      name,
			KeyHash:   hashAPIKey(strings.TrimSpace(raw)),
			KeyPrefix: strings.TrimSpace(raw)[:min(8, len(strings.TrimSpace(raw)))] + "…",
			Scopes:    scopeTasks + "," + scopeScripts + "," + scopeInternal,
			Status:    repo.APIKeyStatusActive,
			CreatedBy: "bootstrap",
		}
		created, err := repo.UpsertAPIKey(row)
		if err != nil {
			slog.Error("[APIKEY] bootstrap key seed failed", "name", name, "err", err)
			continue
		}
		if !created {
			slog.Info("[APIKEY] bootstrap key row kept", "name", name)
		}
	}
	if len(serviceKeys) > 0 {
		slog.Info("[APIKEY] bootstrap service keys seeded", "count", len(serviceKeys))
	}
}

// CurrentAPIKeyName returns the credential name recorded by the middleware
// (audit metadata for script uploads etc.).
func currentAPIKeyName(c *gin.Context) string {
	if v, ok := c.Get(apiKeyCtxName); ok {
		if name, ok := v.(string); ok {
			return name
		}
	}
	return ""
}
