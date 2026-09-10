// Package router: admin console API gate.
//
// The webui is served by the same Gin process (single binary, see web/);
// /api/* endpoints back it. These are admin endpoints that see ALL users'
// payment data, so they are gated by the console account store (bcrypt
// username/password, seeded default admin) plus an optional master API token.
package router

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strconv"
	"sync"
	"time"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

const webuiVersion = "0.2.0"

const (
	// Brute-force throttle: max failed credentials per client IP per window,
	// shared by the login endpoint and the /api/* gate so the limit cannot be
	// bypassed by hammering any other endpoint.
	webuiMaxFails     = 10
	webuiFailWindow   = time.Minute
	webuiDefaultTTL   = 12 * time.Hour
	webuiSessionBytes = 32

	// Browser sessions ride an HttpOnly cookie so the server can gate the
	// console PAGE itself (redirect to /login before any app HTML is sent);
	// programmatic clients use the session id / master token via headers.
	webuiSessionCookie = "payadmin_session"
	webuiCtxUser       = "webui_user" // gin context key for the authed identity
)

// webuiSession is the identity attached to a browser/API session: it always
// carries a username and role so handlers can authorize and audit.
type webuiSession struct {
	UserID   int64
	Username string
	Role     string // admin / viewer
	Expiry   time.Time
}

// registerWebuiRoutes mounts the admin API behind the auth gate. The console
// ALWAYS requires login (a default admin account is seeded at startup), so the
// gate is unconditional; webui.enabled=false disables the whole console.
func (r *Router) registerWebuiRoutes(e *gin.Engine, auth *webuiAuthenticator) {
	// Login/logout sit OUTSIDE the gate: login must be reachable without
	// credentials (it IS the credential check), and logout authenticates with
	// the very session it invalidates.
	e.POST("/api/login", auth.login)
	e.POST("/api/logout", auth.logout)

	api := e.Group("/api", auth.middleware())
	api.GET("/info", r.apiInfo)

	// Pay domain queries (viewer and above).
	api.GET("/orders", r.apiListOrders)
	api.GET("/orders/:order_no", r.apiOrderDetail)
	api.GET("/orders/:order_no/callbacks", r.apiOrderCallbacks)
	api.GET("/memberships", r.apiListMemberships)
	api.GET("/memberships/:uid/events", r.apiMemberEvents)
	api.GET("/events", r.apiListEvents)
	api.GET("/products", r.apiListProducts)

	// Money-touching write: admin only.
	api.POST("/grants", requireAdmin(), r.apiGrant)

	// Account management: admin only.
	users := api.Group("/users", requireAdmin())
	users.GET("", r.apiListUsers)
	users.POST("", r.apiCreateUser)
	users.POST("/:user_id/password", r.apiSetUserPassword)
	users.DELETE("/:user_id", r.apiDeleteUser)
}

// webuiAuthenticator gates the admin console. Two credential kinds are
// accepted, both presented via X-WebUI-Token / Authorization: Bearer:
//   - user sessions issued by POST /api/login (username + password), stored in
//     an HttpOnly cookie for the browser and/or a session id for API clients;
//   - the optional master token (webui.token, constant-time compare) as an
//     API-key fallback for scripts — it authenticates as admin.
//
// Failed attempts are throttled per client IP across ALL /api/* endpoints.
type webuiAuthenticator struct {
	masterToken string
	ttl         time.Duration

	mu          sync.Mutex
	sessions    map[string]webuiSession // session id -> identity
	fails       map[string]int          // client ip -> failures in current window
	windowStart time.Time
}

func newWebuiAuthenticator(token string, ttlMinutes int) *webuiAuthenticator {
	ttl := webuiDefaultTTL
	if ttlMinutes > 0 {
		ttl = time.Duration(ttlMinutes) * time.Minute
	}
	return &webuiAuthenticator{
		masterToken: token,
		ttl:         ttl,
		sessions:    make(map[string]webuiSession),
		fails:       make(map[string]int),
		windowStart: time.Now(),
	}
}

// middleware gates /api/* on a valid credential and stashes the identity for
// downstream handlers. Any failed check counts toward the per-IP throttle; a
// success clears it.
func (a *webuiAuthenticator) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if !a.allow(ip) {
			a.throttleAbort(c)
			return
		}
		sess, ok := a.authenticate(a.extractToken(c))
		if !ok {
			a.fail(ip)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "unauthorized (login required)"})
			return
		}
		a.reset(ip)
		c.Set(webuiCtxUser, sess)
		c.Next()
	}
}

// login exchanges credentials for a fresh session. Accepts either a username +
// password (console login) or the master token (script/API fallback). The
// session is issued BOTH as an HttpOnly+SameSite=Strict cookie (browser flow)
// and in the JSON body (API flow, presented via X-WebUI-Token / Bearer).
func (a *webuiAuthenticator) login(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Token    string `json:"token"`
	}
	_ = c.ShouldBindJSON(&req)
	ip := c.ClientIP()
	if !a.allow(ip) {
		a.throttleAbort(c)
		return
	}

	var sess webuiSession
	var ok bool
	switch {
	case req.Username != "" && req.Password != "":
		sess, ok = a.verifyUser(req.Username, req.Password)
	case req.Token != "":
		sess, ok = a.authenticate(req.Token)
	default:
		// Empty credentials are a fresh visitor, not an attack: reject
		// without burning the throttle budget.
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "username/password or token required"})
		return
	}
	if !ok {
		a.fail(ip)
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "invalid credentials"})
		return
	}
	a.reset(ip)

	sid, err := a.newSession(sess)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "issue session failed"})
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     webuiSessionCookie,
		Value:    sid,
		Path:     "/",
		MaxAge:   int(a.ttl.Seconds()),
		HttpOnly: true,                    // JS can never read it (XSS-proof storage)
		SameSite: http.SameSiteStrictMode, // cross-site requests never carry it (CSRF)
		Secure:   c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https",
	})
	c.JSON(http.StatusOK, gin.H{
		"ok":                 true,
		"session":            sid,
		"expires_in_minutes": int(a.ttl.Minutes()),
		"user":               gin.H{"username": sess.Username, "role": sess.Role, "is_admin": sess.Role == repo.RoleAdmin},
	})
}

// logout invalidates the presented session and clears the session cookie.
func (a *webuiAuthenticator) logout(c *gin.Context) {
	if tok := a.extractToken(c); tok != "" {
		a.mu.Lock()
		delete(a.sessions, tok)
		a.mu.Unlock()
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     webuiSessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *webuiAuthenticator) throttleAbort(c *gin.Context) {
	c.Header("Retry-After", strconv.Itoa(int(webuiFailWindow.Seconds())))
	c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
		"detail": "too many failed attempts, retry after the cooldown",
	})
}

// extractToken finds the presented credential: X-WebUI-Token header, Bearer
// token, or the session cookie (browser navigation requests can only carry
// the cookie, which is what enables the server-side page gate).
func (a *webuiAuthenticator) extractToken(c *gin.Context) string {
	got := c.GetHeader("X-WebUI-Token")
	if got == "" {
		if b := c.GetHeader("Authorization"); len(b) > 7 && b[:7] == "Bearer " {
			got = b[7:]
		}
	}
	if got == "" {
		got, _ = c.Cookie(webuiSessionCookie)
	}
	return got
}

// authenticate resolves a credential (session id or master token) to an
// identity. The master token is compared in constant time and maps to an admin
// identity so scripts can call /api/* without a user session.
func (a *webuiAuthenticator) authenticate(cred string) (webuiSession, bool) {
	if cred == "" {
		return webuiSession{}, false
	}
	if a.masterToken != "" && subtle.ConstantTimeCompare([]byte(cred), []byte(a.masterToken)) == 1 {
		return webuiSession{Username: "master-token", Role: repo.RoleAdmin, Expiry: time.Now().Add(a.ttl)}, true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pruneSessionsLocked()
	if s, ok := a.sessions[cred]; ok && time.Now().Before(s.Expiry) {
		return s, true
	}
	return webuiSession{}, false
}

// verifyUser checks a username + password against the payadmin_user store.
func (a *webuiAuthenticator) verifyUser(username, password string) (webuiSession, bool) {
	u, err := repo.GetUserByUsername(username)
	if err != nil || u == nil {
		return webuiSession{}, false
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		return webuiSession{}, false
	}
	return webuiSession{UserID: u.ID, Username: u.Username, Role: u.Role, Expiry: time.Now().Add(a.ttl)}, true
}

func (a *webuiAuthenticator) newSession(user webuiSession) (string, error) {
	b := make([]byte, webuiSessionBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	sid := hex.EncodeToString(b)
	a.mu.Lock()
	a.sessions[sid] = user
	a.mu.Unlock()
	return sid, nil
}

func (a *webuiAuthenticator) pruneSessionsLocked() {
	now := time.Now()
	for sid, s := range a.sessions {
		if now.After(s.Expiry) {
			delete(a.sessions, sid)
		}
	}
}

func (a *webuiAuthenticator) allow(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollWindowLocked()
	return a.fails[ip] < webuiMaxFails
}

func (a *webuiAuthenticator) fail(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollWindowLocked()
	a.fails[ip]++
}

func (a *webuiAuthenticator) reset(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.fails, ip)
}

func (a *webuiAuthenticator) rollWindowLocked() {
	now := time.Now()
	if now.Sub(a.windowStart) >= webuiFailWindow {
		a.fails = make(map[string]int)
		a.windowStart = now
	}
}

// currentUser reads the authed identity set by the auth middleware.
func currentUser(c *gin.Context) (webuiSession, bool) {
	v, ok := c.Get(webuiCtxUser)
	if !ok {
		return webuiSession{}, false
	}
	s, ok := v.(webuiSession)
	return s, ok
}

// operatorOf returns the authed username for audit logging (empty for master
// token / header-only callers).
func operatorOf(c *gin.Context) string {
	if s, ok := currentUser(c); ok && s.Username != "" {
		return s.Username
	}
	return ""
}

// requireAdmin gates a route group to role=admin.
func requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s, ok := currentUser(c); ok && s.Role == repo.RoleAdmin {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"detail": "admin role required"})
	}
}

// ── info ────────────────────────────────────────────────────────────

func (r *Router) apiInfo(c *gin.Context) {
	out := gin.H{"service": "app-pay-admin", "version": webuiVersion, "status": "running"}
	if s, ok := currentUser(c); ok {
		out["user"] = gin.H{"username": s.Username, "role": s.Role, "is_admin": s.Role == repo.RoleAdmin}
	}
	c.JSON(http.StatusOK, out)
}

// ── shared helpers ──────────────────────────────────────────────────

func pagination(c *gin.Context, def, max int) (limit, offset int) {
	limit = def
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= max {
			limit = n
		}
	}
	if o := c.Query("offset"); o != "" {
		if n, err := strconv.Atoi(o); err == nil && n >= 0 {
			offset = n
		}
	}
	return limit, offset
}

func timePtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339)
}
