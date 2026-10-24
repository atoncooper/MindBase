// Session gate + auth endpoints: cookie name admin_session (HttpOnly,
// SameSite=Lax so the same-origin SPA and dev proxy both work), sliding 12h
// TTL enforced by the service, login throttle 10 failures / minute / IP.
package router

import (
	"errors"
	"net/http"
	"strconv"
	"time"

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

// secureCookie decides whether the session cookie gets the Secure flag based
// on the transport actually seen by this process.
func secureCookie(c *gin.Context) bool {
	return c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https"
}

// setSessionCookie / clearSessionCookie centralise cookie attributes.
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

func clearSessionCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secureCookie(c),
	})
}

// sessionGate resolves the admin_session cookie to a live DB session and
// slides its expiry (sliding 12h). 401 with {"detail": ...} otherwise.
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
		c.Set(ctxIdentity, adminIdentity{
			UserID:             bundle.User.ID,
			Username:           bundle.User.Username,
			Role:               bundle.User.Role,
			MustChangePassword: bundle.User.MustChangePassword,
		})
		c.Next()
	}
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
	ip := c.ClientIP()
	user, token, err := r.auth.Login(req.Username, req.Password, ip, c.Request.UserAgent())
	switch {
	case errors.Is(err, service.ErrThrottled):
		c.Header("Retry-After", strconv.Itoa(int(time.Minute.Seconds())))
		detail(c, http.StatusTooManyRequests, "too many failed attempts, retry after the cooldown")
	case errors.Is(err, service.ErrInvalidCredentials):
		detail(c, http.StatusUnauthorized, "invalid credentials")
	case err != nil:
		serverError(c, err, "login")
	default:
		setSessionCookie(c, token, r.auth.TTLSeconds(), secureCookie(c))
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
	if err := r.auth.Logout(id.Username, token, c.ClientIP()); err != nil {
		serverError(c, err, "logout")
		return
	}
	clearSessionCookie(c)
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

// bcrypt stays referenced: hashing itself lives in the repo/service layers.
var _ = bcrypt.DefaultCost
