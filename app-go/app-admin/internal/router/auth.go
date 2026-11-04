// Session gate + auth endpoints: cookie name admin_session (HttpOnly,
// SameSite=Lax so the same-origin SPA and dev proxy both work), sliding 12h
// TTL enforced by the service, the device / IP binding checks re-run on every
// authenticated request, and the login throttle budgets held by the service.
package router

import (
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-admin/internal/config"
	"app-admin/internal/dto"
	"app-admin/internal/repo"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie = "admin_session"
	ctxIdentity   = "admin_identity"
)

// adminIdentity is the authed console identity attached to the request.
type adminIdentity struct {
	UserID             int64
	Username           string
	Role               string
	MustChangePassword bool
}

// identityOf reads the authed console identity set by the session gate.
func identityOf(c *gin.Context) (adminIdentity, bool) {
	v, ok := c.Get(ctxIdentity)
	if !ok {
		return adminIdentity{}, false
	}
	id, ok := v.(adminIdentity)
	return id, ok
}

// setSessionCookie centralises the cookie attributes.
func setSessionCookie(c *gin.Context, token string, maxAge int, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

func clearSessionCookie(c *gin.Context, secure bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// clientIP resolves the real client address honouring the trusted-proxy list.
func (r *Router) clientIP(c *gin.Context) string {
	return clientIP(c, r.trustedProxies)
}

// sessionCookieSecure reports whether the cookie may carry the Secure flag.
func (r *Router) sessionCookieSecure(c *gin.Context) bool {
	return secureCookie(c, r.trustedProxies)
}

// sessionGate resolves the admin_session cookie to a live DB session, re-checks
// its device / IP binding and only then slides its expiry. 401 with
// {"detail": ...} otherwise.
func (r *Router) sessionGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, _ := c.Cookie(sessionCookie)
		if token == "" {
			detail(c, http.StatusUnauthorized, "login required")
			c.Abort()
			return
		}
		bundle, err := r.auth.ResolveSession(token)
		if err != nil {
			serverError(c, err, "resolve session")
			c.Abort()
			return
		}
		if bundle == nil {
			detail(c, http.StatusUnauthorized, "login required")
			c.Abort()
			return
		}
		if !r.sessionBindingOK(c, token, bundle) {
			return // rejection response already written
		}
		// Sliding expiry only after the binding checks pass, so a rejected
		// request cannot keep a stolen session alive.
		if err := r.auth.TouchSession(token); err != nil {
			serverError(c, err, "touch session")
			c.Abort()
			return
		}
		c.Set(ctxIdentity, adminIdentity{
			UserID:             bundle.User.ID,
			Username:           bundle.User.Username,
			Role:               bundle.User.Role,
			MustChangePassword: bundle.User.MustChangePassword,
		})
		c.Next()
	}
}

// sessionBindingOK re-checks the presented session against the current request:
// device fingerprint (when enabled) and client address (off / exact / subnet).
// A mismatch means the cookie is being replayed from another device or network,
// so the row is deleted, the attempt audited and the caller told to log in
// again. Sessions created before device binding was enabled carry no hash and
// therefore always fail the device check after an upgrade.
func (r *Router) sessionBindingOK(c *gin.Context, token string, bundle *repo.SessionBundle) bool {
	ip := r.clientIP(c)
	deviceMode := r.cfg.Session.DeviceBindingMode()
	if deviceMode != "off" {
		fingerprint, err := deviceFingerprint(c, deviceMode)
		if err != nil || bundle.Session.DeviceHash == "" ||
			subtle.ConstantTimeCompare([]byte(bundle.Session.DeviceHash), []byte(fingerprint)) != 1 {
			r.dropMismatchedSession(c, token, bundle, "session_device_mismatch", ip, fingerprint)
			return false
		}
	}
	ipMode := r.cfg.Session.IPBindingMode()
	if ipMode != "off" && !sessionIPMatches(bundle.Session.IP, ip, ipMode, r.cfg.Session) {
		r.dropMismatchedSession(c, token, bundle, "session_ip_mismatch", ip, "")
		return false
	}
	return true
}

// dropMismatchedSession invalidates the presented session and answers 401 in
// the shared error shape.
func (r *Router) dropMismatchedSession(c *gin.Context, token string, bundle *repo.SessionBundle,
	action, ip, fingerprint string) {
	_ = repo.DeleteSession(token)
	detailText := "ip=" + truncateStr(ip, 60) + " device=" + devicePrefix(fingerprint)
	_ = repo.RecordAudit(bundle.User.Username, action, "session",
		strconv.FormatInt(bundle.User.ID, 10), detailText)
	clearSessionCookie(c, r.sessionCookieSecure(c))
	detail(c, http.StatusUnauthorized, "login required")
	c.Abort()
}

// sessionIPMatches compares the stored session address with the current client
// address under the configured policy. An empty / unparsable stored value or a
// family mismatch fails closed.
func sessionIPMatches(stored *string, current, mode string, sessionCfg config.SessionConfig) bool {
	if stored == nil || strings.TrimSpace(*stored) == "" {
		return false
	}
	storedIP := net.ParseIP(strings.TrimSpace(*stored))
	currentIP := net.ParseIP(strings.TrimSpace(current))
	if storedIP == nil || currentIP == nil {
		return false
	}
	if mode == "exact" {
		return storedIP.Equal(currentIP)
	}
	storedV4, currentV4 := storedIP.To4(), currentIP.To4()
	if storedV4 != nil || currentV4 != nil {
		if storedV4 == nil || currentV4 == nil {
			return false
		}
		mask := net.CIDRMask(sessionCfg.IPv4PrefixOr(), 32)
		return storedV4.Mask(mask).Equal(currentV4.Mask(mask))
	}
	mask := net.CIDRMask(sessionCfg.IPv6PrefixOr(), 128)
	return storedIP.To16().Mask(mask).Equal(currentIP.To16().Mask(mask))
}

// requireAdmin gates admin-only writes (ban / unban / approve). Password
// change deliberately sits OUTSIDE this gate.
func requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := identityOf(c)
		if !ok || id.Role != repo.RoleAdmin {
			detail(c, http.StatusForbidden, "admin role required")
			c.Abort()
			return
		}
		c.Next()
	}
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (r *Router) apiLogin(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		detail(c, http.StatusBadRequest, "json body with username/password required")
		return
	}
	// Resolve the fingerprint before touching the throttle: a malformed device
	// header is a client bug, not a credential guess.
	fingerprint, err := deviceFingerprint(c, r.cfg.Session.DeviceBindingMode())
	if err != nil {
		detail(c, http.StatusBadRequest, err.Error())
		return
	}
	ip := r.clientIP(c)
	user, token, err := r.auth.Login(req.Username, req.Password, ip, c.Request.UserAgent(), fingerprint)
	switch {
	case errors.Is(err, service.ErrThrottled):
		c.Header("Retry-After", strconv.Itoa(int(time.Minute.Seconds())))
		detail(c, http.StatusTooManyRequests, "too many failed attempts, retry after the cooldown")
	case errors.Is(err, service.ErrInvalidCredentials):
		detail(c, http.StatusUnauthorized, "invalid credentials")
	case err != nil:
		serverError(c, err, "login")
	default:
		setSessionCookie(c, token, r.auth.TTLSeconds(), r.sessionCookieSecure(c))
		c.JSON(http.StatusOK, dto.SessionInfo{
			Username:           user.Username,
			Role:               user.Role,
			MustChangePassword: user.MustChangePassword,
		})
	}
}

func (r *Router) apiLogout(c *gin.Context) {
	id, _ := identityOf(c)
	token, _ := c.Cookie(sessionCookie)
	if err := r.auth.Logout(id.Username, token, r.clientIP(c)); err != nil {
		serverError(c, err, "logout")
		return
	}
	clearSessionCookie(c, r.sessionCookieSecure(c))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (r *Router) apiMe(c *gin.Context) {
	id, _ := identityOf(c)
	c.JSON(http.StatusOK, dto.SessionInfo{
		Username:           id.Username,
		Role:               id.Role,
		MustChangePassword: id.MustChangePassword,
	})
}

type changePasswordRequest struct {
	OldPassword string `json:"oldPassword"`
	NewPassword string `json:"newPassword"`
}

func (r *Router) apiChangePassword(c *gin.Context) {
	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		detail(c, http.StatusBadRequest, "json body with oldPassword/newPassword required")
		return
	}
	id, _ := identityOf(c)
	user, err := repo.GetUserByID(id.UserID)
	if err != nil {
		serverError(c, err, "load account")
		return
	}
	if user == nil {
		detail(c, http.StatusUnauthorized, "login required")
		c.Abort()
		return
	}
	if err := r.auth.ChangePassword(user, req.OldPassword, req.NewPassword); err != nil {
		switch {
		case errors.Is(err, repo.ErrWrongOldPass):
			detail(c, http.StatusBadRequest, "old password incorrect")
		case errors.Is(err, repo.ErrWeakPassword):
			detail(c, http.StatusBadRequest, "new password must be at least 8 characters")
		default:
			serverError(c, err, "change password")
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// truncateStr bounds a value before it lands in a fixed-width audit column.
func truncateStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// bcrypt stays referenced: hashing itself lives in the repo/service layers.
var _ = bcrypt.DefaultCost
