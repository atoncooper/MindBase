// Package router: admin console API for the embedded web UI.
//
// The webui is served by the same Gin process (single binary, see web.go);
// /api/* endpoints back it. Unlike the APISIX-facing /tasks/* endpoints (which
// trust the injected X-Uid), these are admin endpoints that see ALL users'
// data, so they are gated by the configured webui token (see config.WebUI).
package router

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"app-task/internal/config"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/datatypes"
)

const webuiVersion = "0.5.0"

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
	webuiSessionCookie = "apptask_session"
	webuiCtxUser       = "webui_user" // gin context key for the authed identity
)

// webuiSession is the identity attached to a browser/API session: it always
// carries a username and role so handlers can authorize and audit.
type webuiSession struct {
	UserID   int64
	Username string
	Role     string // admin / member
	Expiry   time.Time
}

// registerWebuiRoutes mounts the admin API behind the auth gate. The console
// ALWAYS requires login (a default admin account is seeded at startup), so the
// gate is unconditional; webui.enabled=false disables the whole console.
func (r *Router) registerWebuiRoutes(e *gin.Engine, cfg *config.Config, auth *webuiAuthenticator) {
	// Login/logout sit OUTSIDE the gate: login must be reachable without
	// credentials (it IS the credential check), and logout authenticates with
	// the very session it invalidates.
	e.POST("/api/login", auth.login)
	e.POST("/api/logout", auth.logout)

	api := e.Group("/api", auth.middleware())
	api.GET("/info", r.apiInfo)
	api.GET("/stats", r.apiStats)

	api.GET("/tasks", r.apiListTasks)
	api.GET("/tasks/:task_id", r.apiTaskDetail)
	api.POST("/tasks", r.apiCreateTask)

	api.GET("/logs", r.apiListLogs)

	api.GET("/emails", r.apiListEmails)
	api.POST("/emails/:email_id/retry", r.apiRetryEmail)

	api.GET("/scripts", r.apiListScripts)
	api.GET("/scripts/:script_id", r.apiScriptDetail)
	api.POST("/scripts", r.apiCreateScript)
	api.POST("/scripts/:script_id/toggle", r.apiToggleScript)

	// Account management: admin-only.
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
		HttpOnly: true,                  // JS can never read it (XSS-proof storage)
		SameSite: http.SameSiteStrictMode, // cross-site requests never carry it (CSRF)
		Secure:   c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https",
	})
	c.JSON(http.StatusOK, gin.H{
		"ok":                 true,
		"session":            sid,
		"expires_in_minutes": int(a.ttl.Minutes()),
		"user":               gin.H{"username": sess.Username, "role": sess.Role, "is_admin": sess.Role == "admin"},
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
		return webuiSession{Username: "master-token", Role: "admin", Expiry: time.Now().Add(a.ttl)}, true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pruneSessionsLocked()
	if s, ok := a.sessions[cred]; ok && time.Now().Before(s.Expiry) {
		return s, true
	}
	return webuiSession{}, false
}

// verifyUser checks a username + password against the webui_user store.
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
		if s, ok := currentUser(c); ok && s.Role == "admin" {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"detail": "admin role required"})
	}
}

// ── info / stats ────────────────────────────────────────────────────

func (r *Router) apiInfo(c *gin.Context) {
	out := gin.H{"service": "app-task", "version": webuiVersion, "status": "running"}
	if s, ok := currentUser(c); ok {
		out["user"] = gin.H{"username": s.Username, "role": s.Role, "is_admin": s.Role == "admin"}
	}
	c.JSON(http.StatusOK, out)
}

// apiStats aggregates dashboard counters: tasks by status, execution log
// total, email queue by status, script count.
func (r *Router) apiStats(c *gin.Context) {
	tasks, err := repo.CountTasksByStatus()
	if err != nil {
		tasks = map[string]int64{}
	}
	taskTotal, _ := repo.CountTasks("")
	logsTotal, _ := repo.CountTaskLogs()
	emails, _ := repo.CountEmailsByStatus()
	if emails == nil {
		emails = map[string]int64{}
	}
	emailTotal, _ := repo.CountEmails("")
	scripts, _ := repo.CountScripts()

	c.JSON(http.StatusOK, gin.H{
		"service":    gin.H{"status": "running", "version": webuiVersion},
		"tasks":      withTotal(tasks, taskTotal),
		"logs_total": logsTotal,
		"emails":     withTotal(emails, emailTotal),
		"scripts":    scripts,
		"now":        time.Now().Format(time.RFC3339),
	})
}

func withTotal(m map[string]int64, total int64) gin.H {
	out := gin.H{}
	for k, v := range m {
		out[k] = v
	}
	out["total"] = total
	return out
}

// ── tasks ───────────────────────────────────────────────────────────

func (r *Router) apiListTasks(c *gin.Context) {
	limit, offset := pagination(c, 50, 200)
	status := c.Query("status")
	tasks, err := repo.ListAllTasks(status, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	total, _ := repo.CountTasks(status)
	out := make([]gin.H, 0, len(tasks))
	for _, j := range tasks {
		out = append(out, taskView(&j))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "tasks": out})
}

func (r *Router) apiTaskDetail(c *gin.Context) {
	taskID := c.Param("task_id")
	task, err := repo.GetTaskByID(taskID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	if task == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "task not found"})
		return
	}
	logs, _ := repo.ListTaskLogs(taskID, 50)
	logOut := make([]gin.H, 0, len(logs))
	for _, l := range logs {
		logOut = append(logOut, taskLogView(&l))
	}
	c.JSON(http.StatusOK, gin.H{"task": taskView(task), "logs": logOut})
}

// apiCreateTask registers a task from the admin console form. uid defaults to
// 0 (system) when omitted — unlike /tasks/register which requires it.
func (r *Router) apiCreateTask(c *gin.Context) {
	var req struct {
		UID         int64           `json:"uid"`
		TaskType    string          `json:"task_type"`
		Payload     json.RawMessage `json:"payload"`
		ExecutorURL string          `json:"executor_url"`
		Async       bool            `json:"async"`
		CronExpr    string          `json:"cron_expr"`
		TriggerTime string          `json:"trigger_time"`
		MaxRetry    int             `json:"max_retry"`
		Weight      int             `json:"weight"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	var triggerTime time.Time
	if req.CronExpr == "" && req.TriggerTime == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "trigger_time required when cron_expr is empty"})
		return
	}
	if req.TriggerTime != "" {
		t, err := parseISO8601(req.TriggerTime)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid trigger_time (expect ISO8601)"})
			return
		}
		triggerTime = t
	}
	taskID, err := r.taskSvc.RegisterTask(req.UID, req.TaskType, req.Payload, req.ExecutorURL, req.Async, req.CronExpr, triggerTime, req.MaxRetry, req.Weight)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "register failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": "pending"})
}

// taskView maps a Task row to the admin console JSON shape.
func taskView(j *model.Task) gin.H {
	return gin.H{
		"task_id":           j.TaskID,
		"uid":               j.UID,
		"task_type":         j.TaskType,
		"status":            j.Status,
		"trigger_time":      j.TriggerTime.Format(time.RFC3339),
		"executor_url":      j.ExecutorURL,
		"async":             j.Async,
		"cron_expr":         j.CronExpr,
		"cron_next_task_id": j.CronNextTaskID,
		"max_retry":         j.MaxRetry,
		"retry_count":       j.RetryCount,
		"next_retry_at":     timePtr(j.NextRetryAt),
		"last_result":       j.LastResult,
		"weight":            j.Weight,
		"payload":           payloadView(j.Payload),
		"created_at":        j.CreatedAt.Format(time.RFC3339),
		"updated_at":        j.UpdatedAt.Format(time.RFC3339),
	}
}

// ── execution logs ──────────────────────────────────────────────────

func (r *Router) apiListLogs(c *gin.Context) {
	limit := 50
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	logs, err := repo.ListRecentLogs(c.Query("task_id"), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(logs))
	for _, l := range logs {
		out = append(out, taskLogView(&l))
	}
	c.JSON(http.StatusOK, gin.H{"logs": out})
}

func taskLogView(l *model.TaskLog) gin.H {
	return gin.H{
		"log_id":      l.LogID,
		"task_id":     l.TaskID,
		"trigger_at":  l.TriggerAt.Format(time.RFC3339),
		"executor":    l.Executor,
		"status":      l.Status,
		"duration_ms": l.DurationMS,
		"response":    l.Response,
		"error":       l.Error,
	}
}

// ── email queue ─────────────────────────────────────────────────────

func (r *Router) apiListEmails(c *gin.Context) {
	limit, offset := pagination(c, 50, 200)
	status := c.Query("status")
	emails, err := repo.ListEmails(status, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	total, _ := repo.CountEmails(status)
	out := make([]gin.H, 0, len(emails))
	for _, e := range emails {
		out = append(out, emailView(&e))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "emails": out})
}

func (r *Router) apiRetryEmail(c *gin.Context) {
	emailID := c.Param("email_id")
	ok, err := repo.ResetEmailForRetry(emailID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusConflict, gin.H{"detail": "email not in failed state (or not found)"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"email_id": emailID, "status": "pending"})
}

func emailView(e *model.EmailMessage) gin.H {
	return gin.H{
		"email_id":      e.EmailID,
		"to":            toStringSlice(e.To),
		"cc":            toStringSlice(e.CC),
		"subject":       e.Subject,
		"reference_id":  e.ReferenceID,
		"status":        e.Status,
		"retry_count":   e.RetryCount,
		"next_retry_at": timePtr(e.NextRetryAt),
		"last_error":    e.LastError,
		"created_at":    e.CreatedAt.Format(time.RFC3339),
		"sent_at":       timePtr(e.SentAt),
	}
}

// ── lua scripts ─────────────────────────────────────────────────────

func (r *Router) apiListScripts(c *gin.Context) {
	scripts, err := repo.ListScripts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(scripts))
	for _, s := range scripts {
		out = append(out, gin.H{
			"script_id":   s.ScriptID,
			"name":        s.Name,
			"description": s.Description,
			"version":     s.Version,
			"enabled":     s.Enabled,
			"updated_at":  s.UpdatedAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"scripts": out})
}

func (r *Router) apiScriptDetail(c *gin.Context) {
	scriptID := c.Param("script_id")
	latest, err := repo.GetLatestScript(scriptID)
	if err == repo.ErrScriptNotFound {
		c.JSON(http.StatusNotFound, gin.H{"detail": "script not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	versions, _ := repo.ListScriptVersions(scriptID)
	verOut := make([]gin.H, 0, len(versions))
	for _, v := range versions {
		verOut = append(verOut, gin.H{
			"version":    v.Version,
			"name":       v.Name,
			"enabled":    v.Enabled,
			"source":     v.Source,
			"updated_at": v.UpdatedAt.Format(time.RFC3339),
		})
	}
	audit, _ := repo.ListScriptLogs(scriptID, 50)
	auditOut := make([]gin.H, 0, len(audit))
	for _, l := range audit {
		auditOut = append(auditOut, gin.H{
			"log_id":     l.LogID,
			"version":    l.Version,
			"action":     l.Action,
			"operator":   l.Operator,
			"source_ip":  l.SourceIP,
			"request_id": l.RequestID,
			"summary":    l.Summary,
			"created_at": l.CreatedAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"script_id":   latest.ScriptID,
		"name":        latest.Name,
		"description": latest.Description,
		"version":     latest.Version,
		"enabled":     latest.Enabled,
		"source":      latest.Source,
		"updated_at":  latest.UpdatedAt.Format(time.RFC3339),
		"versions":    verOut,
		"logs":        auditOut,
	})
}

func (r *Router) apiCreateScript(c *gin.Context) {
	var req scriptUploadBody
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	version, logID, err := r.applyScriptUpload(req, c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "script rejected: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"script_id": req.ScriptID, "version": version, "log_id": logID, "status": "ok"})
}

// apiToggleScript flips the enabled flag on the latest version without
// creating a new version; every change is audit-logged.
func (r *Router) apiToggleScript(c *gin.Context) {
	scriptID := c.Param("script_id")
	var req struct {
		Enabled  bool   `json:"enabled"`
		Operator string `json:"operator" binding:"max=64"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	latest, err := repo.GetLatestScript(scriptID)
	if err == repo.ErrScriptNotFound {
		c.JSON(http.StatusNotFound, gin.H{"detail": "script not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	if err := repo.UpdateScriptEnabled(scriptID, req.Enabled); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	operator := req.Operator
	if operator == "" {
		operator = c.GetHeader("X-Operator")
	}
	if operator == "" {
		operator = operatorOf(c)
	}
	state := "enabled"
	if !req.Enabled {
		state = "disabled"
	}
	_ = repo.CreateScriptLog(&model.ScriptLog{
		LogID:     uuid.NewString(),
		ScriptID:  scriptID,
		Version:   latest.Version,
		Action:    "toggle",
		Operator:  operator,
		SourceIP:  c.ClientIP(),
		RequestID: c.GetHeader("X-Request-Id"),
		Summary:   "v" + strconv.Itoa(latest.Version) + " " + state,
	})
	c.JSON(http.StatusOK, gin.H{"script_id": scriptID, "version": latest.Version, "enabled": req.Enabled})
}

// ── webui users (admin only) ───────────────────────────────────────

func (r *Router) apiListUsers(c *gin.Context) {
	us, err := repo.ListUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(us))
	for _, u := range us {
		out = append(out, gin.H{
			"id":         u.ID,
			"username":   u.Username,
			"role":       u.Role,
			"created_at": u.CreatedAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"users": out})
}

func (r *Router) apiCreateUser(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required,min=2,max=64"`
		Password string `json:"password" binding:"required,min=8,max=128"`
		Role     string `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}
	if req.Role != "admin" && req.Role != "member" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "role must be admin or member"})
		return
	}
	u, err := repo.CreateUser(req.Username, req.Password, req.Role)
	if err == repo.ErrUserExists {
		c.JSON(http.StatusConflict, gin.H{"detail": "username already exists"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "create user failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": u.ID, "username": u.Username, "role": u.Role})
}

func (r *Router) apiSetUserPassword(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid user id"})
		return
	}
	var req struct {
		Password string `json:"password" binding:"required,min=8,max=128"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	if err := repo.SetUserPassword(id, req.Password); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (r *Router) apiDeleteUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid user id"})
		return
	}
	me, ok := currentUser(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "unauthorized"})
		return
	}
	if me.UserID == id {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "cannot delete your own account"})
		return
	}
	target, err := repo.GetUserByID(id)
	if err != nil || target == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "user not found"})
		return
	}
	if target.Role == "admin" {
		admins, _ := repo.CountUsersByRole("admin")
		if admins <= 1 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "cannot delete the last admin"})
			return
		}
	}
	if err := repo.DeleteUser(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
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

// payloadView renders the opaque task payload for display: pretty-printed
// JSON when possible, raw string otherwise.
func payloadView(p datatypes.JSON) any {
	if len(p) == 0 {
		return nil
	}
	var pretty any
	if err := json.Unmarshal(p, &pretty); err == nil {
		return pretty
	}
	return string(p)
}

// toStringSlice decodes a JSON-encoded string array (email to/cc columns).
func toStringSlice(j datatypes.JSON) []string {
	var ss []string
	if len(j) > 0 {
		_ = json.Unmarshal(j, &ss)
	}
	return ss
}
