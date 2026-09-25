package router

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
)

// registerAuth mounts all user-facing /auth/* endpoints (routes match the
// Python backend exactly so the frontend's authApi is untouched).
func registerAuth(e *gin.Engine, d Deps) {
	g := e.Group("/auth")
	// Per-IP fixed-window guard on the whole /auth surface (approximation of
	// the Python 1rps/burst5 token bucket): 5 requests per second per IP,
	// fail-open when Redis is down.
	g.Use(func(c *gin.Context) {
		ip := service.ClientIP(c.Request.Header.Get("X-Forwarded-For"),
			c.Request.Header.Get("X-Real-IP"), c.Request.RemoteAddr)
		if !d.IPGuard.Allow(c.Request.Context(), "ip:"+ip, 5, time.Second) {
			retry := d.IPGuard.RetryAfter(c.Request.Context(), "ip:"+ip)
			c.Header("Retry-After", strconv.Itoa(retry))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"detail": "请求过于频繁，请稍后再试"})
			return
		}
		c.Next()
	})

	// public
	g.GET("/features", featuresHandler(d))
	g.GET("/captcha", getCaptcha(d))
	g.GET("/qrcode", generateQRCode(d))
	g.GET("/qrcode/poll/:qrcode_key", pollQRCode(d))
	g.GET("/wechat/qrcode", wechatQROptions(d))
	g.POST("/wechat/login", wechatLogin(d))
	g.POST("/login", passwordLogin(d))
	g.POST("/register/email/send-code", registerSendCode(d))
	g.POST("/register/email", registerEmail(d))
	g.POST("/phone/send-code", phoneSendCode(d))
	g.POST("/phone/login", phoneLogin(d))
	g.POST("/password/reset-request", passwordResetRequest(d))
	g.POST("/password/reset", passwordReset(d))

	// authenticated
	authed := g.Group("", authGuard(d.Tokens))
	authed.GET("/me", getMe(d))
	authed.DELETE("/token", logoutCurrent(d))
	authed.GET("/tokens", listSessions(d))
	authed.DELETE("/tokens", logoutAll(d))
	authed.DELETE("/tokens/:session_token", revokeSession(d))
	authed.GET("/profile", getProfile(d))
	authed.PATCH("/profile", updateProfile(d))
	authed.POST("/password/set", setPassword(d))
	authed.PATCH("/password", changePassword(d))
	authed.PUT("/email", bindEmail(d))
	authed.DELETE("/email", unbindEmail(d))
	authed.POST("/email/send-code", emailSendCode(d))
	authed.POST("/email/verify", emailVerify(d))
	authed.PUT("/phone", bindPhone(d))
	authed.DELETE("/phone", unbindPhone(d))
	authed.POST("/phone/verify", phoneVerify(d))
	authed.GET("/devices", listDevices(d))
	authed.GET("/security", getSecurity(d))
	authed.POST("/wechat/bind", wechatBind(d))
}

// ── shared helpers ───────────────────────────────────────────────────

// featuresHandler reports enabled login channels (frontend show/hide).
func featuresHandler(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"email_register_enabled": d.Cfg.Email.Enabled,
			"sms_enabled":            d.Cfg.SMS.Enabled,
		})
	}
}

// authGuard resolves the caller's uid from the session token (Authorization
// Bearer or ?token=) and stores it on the context; 401 otherwise.
func authGuard(tokens *service.TokenService) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			apiErr(c, http.StatusUnauthorized, "未提供认证 token")
			return
		}
		uid := tokens.Validate(c.Request.Context(), token)
		if uid == 0 {
			apiErr(c, http.StatusUnauthorized, "token 无效或已过期")
			return
		}
		c.Set("uid", uid)
		c.Set("session_token", token)
		c.Next()
	}
}

func currentUID(c *gin.Context) int64 {
	v, _ := c.Get("uid")
	uid, _ := v.(int64)
	return uid
}

func currentToken(c *gin.Context) string {
	v, _ := c.Get("session_token")
	s, _ := v.(string)
	return s
}

// requireCaptcha verifies the graphical captcha (fail-open when the gate is
// degraded). Single-use: consumed on success and failure.
func requireCaptcha(d Deps, c *gin.Context, captchaID, captchaCode, endpoint string) bool {
	if d.Captcha.Verify(c.Request.Context(), captchaID, captchaCode) {
		return true
	}
	if captchaID != "" && captchaCode != "" {
		apiErr(c, http.StatusBadRequest, "图形验证码错误或已过期")
	} else {
		apiErr(c, http.StatusBadRequest, "请输入图形验证码")
	}
	return false
}

// clientIP is the shared per-request IP extraction (proxy-aware).
func clientIP(c *gin.Context) string {
	return service.ClientIP(c.Request.Header.Get("X-Forwarded-For"),
		c.Request.Header.Get("X-Real-IP"), c.Request.RemoteAddr)
}

// rlIP — per-endpoint per-IP guard; renders 429 + Retry-After and returns
// false when the limit is hit.
func rlIP(d Deps, c *gin.Context, name string) bool {
	return rlKey(d, c, name, "ip:"+clientIP(c))
}

// rlKey — per-endpoint guard for an arbitrary dimension value (identifier,
// phone, email, uid...).
func rlKey(d Deps, c *gin.Context, name, value string) bool {
	allowed, retryAfter := d.RateLimits.Allow(c.Request.Context(), name, value)
	if !allowed {
		apiErr(c, http.StatusTooManyRequests, "请求过于频繁，请稍后再试", retryAfter)
		return false
	}
	return true
}

// qrcodeClientPool shares B站 passport clients (cookie jars) between the
// generate and poll calls — parity with the Python _qrcode_clients dict.
type qrcodeClientPool struct {
	mu      sync.Mutex
	clients map[string]*service.BilibiliPassport
}

func newQRCodeClientPool() *qrcodeClientPool {
	return &qrcodeClientPool{clients: map[string]*service.BilibiliPassport{}}
}

func (p *qrcodeClientPool) get(key string) *service.BilibiliPassport {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[key]
	delete(p.clients, key) // single poll per key; callers re-add for "waiting"
	return c
}

func (p *qrcodeClientPool) put(key string, c *service.BilibiliPassport) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.clients[key] = c
}

func (p *qrcodeClientPool) pop(key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.clients, key)
}

// normalizeKey strips accidental "{}" wrapping from URL interpolation.
func normalizeKey(key string) string {
	return strings.Trim(key, "{}")
}

// userPayload builds the TokenResponse.user_info object.
func (d Deps) userPayload(c *gin.Context, uid int64) (nickname, avatar *string, status string, roles []string) {
	info, err := d.Auth.GetUserByUID(uid)
	if err != nil || info == nil {
		return nil, nil, "active", []string{"free"}
	}
	if len(info.Roles) == 0 {
		info.Roles = []string{"free"}
	}
	return info.Nickname, info.Avatar, info.Status, info.Roles
}
