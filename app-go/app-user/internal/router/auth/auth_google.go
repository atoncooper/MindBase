package router

import (
	"log/slog"
	"net/http"
	"time"

	authdto "app-user/internal/dto/auth"
	"app-user/internal/service/auth"

	"github.com/gin-gonic/gin"
)

// googleOptions — GET /auth/google/options: returns the Google consent URL and
// a one-time state. The frontend opens it in a popup. enabled=false when the
// provider is not configured, so the button stays hidden.
func googleOptions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if d.Google == nil || !d.Google.Enabled() {
			c.JSON(http.StatusOK, authdto.GoogleOptions{Enabled: false})
			return
		}
		purpose := service.GoogleStateLogin
		if c.Query("purpose") == "bind" {
			uid := d.Tokens.Validate(c.Request.Context(), extractToken(c))
			if uid == 0 {
				apiErr(c, http.StatusUnauthorized, "绑定操作需要登录")
				return
			}
			if err := d.Auth.CheckActive(c.Request.Context(), uid); err != nil {
				apiErr(c, http.StatusUnauthorized, "账号不可用")
				return
			}
			purpose = service.GoogleStateBind
		}
		url, state, err := d.Google.AuthorizeURL(c.Request.Context(), purpose)
		if err != nil {
			slog.Warn("[AUTH] google authorize url failed", "err", err)
			c.JSON(http.StatusOK, authdto.GoogleOptions{Enabled: false})
			return
		}
		c.JSON(http.StatusOK, authdto.GoogleOptions{Enabled: true, URL: url, State: state})
	}
}

func resolveGoogleIdentity(d Deps, c *gin.Context, code, state, purpose string) (*service.GoogleProfile, *service.ProviderData, bool) {
	if d.Google == nil || !d.Google.Enabled() {
		apiErr(c, http.StatusBadRequest, "Google 登录未启用")
		return nil, nil, false
	}
	if !d.Google.ConsumeState(c.Request.Context(), state, purpose) {
		apiErr(c, http.StatusBadRequest, "登录状态已过期，请重新授权")
		return nil, nil, false
	}
	tok, err := d.Google.ExchangeCode(c.Request.Context(), code)
	if err != nil {
		apiErr(c, http.StatusBadGateway, err.Error())
		return nil, nil, false
	}
	profile, err := d.Google.GetUserInfo(c.Request.Context(), tok.AccessToken)
	if err != nil {
		apiErr(c, http.StatusBadGateway, err.Error())
		return nil, nil, false
	}
	data := &service.ProviderData{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken}
	if tok.ExpiresIn > 0 {
		exp := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		data.ExpiresAt = &exp
	}
	return profile, data, true
}

func googleProfilePatch(profile *service.GoogleProfile) *service.ProfilePatch {
	patch := &service.ProfilePatch{}
	if profile.Name != "" {
		name := profile.Name
		patch.Nickname = &name
	}
	if profile.Picture != "" {
		patch.Avatar = service.NormalizeAvatarURL(&profile.Picture)
	}
	if profile.EmailVerified && profile.Email != "" {
		email := profile.Email
		patch.Email = &email
	}
	return patch
}

// googleLogin — POST /auth/google/login (register on first use).
func googleLogin(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req authdto.GoogleRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		profile, data, ok := resolveGoogleIdentity(d, c, req.Code, req.State, service.GoogleStateLogin)
		if !ok {
			return
		}
		ip, deviceID, ua, meta := requestContext(c)
		ipPtr, devPtr, uaPtr := ip, deviceID, ua
		uid, token, err := d.Auth.EnsureUserFromOAuth("google", profile.Sub, data,
			googleProfilePatch(profile), &devPtr, &ipPtr, &uaPtr)
		if err != nil {
			slog.Error("[AUTH] google login failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "Google 登录失败，请稍后重试")
			return
		}
		d.Auth.RecordDevice(uid, deviceID, meta)
		slog.Info("[AUTH] google login ok", "uid", uid)
		expires := time.Now().AddDate(0, 0, d.Cfg.Auth.TokenTTLDays)
		tokenResponse(d, c, uid, token, &expires)
	}
}

// googleBind — POST /auth/google/bind (authenticated; settings page).
func googleBind(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req authdto.GoogleRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		profile, data, ok := resolveGoogleIdentity(d, c, req.Code, req.State, service.GoogleStateBind)
		if !ok {
			return
		}
		uid := currentUID(c)
		if err := d.Auth.BindOAuthToUser(uid, "google", profile.Sub, data, googleProfilePatch(profile)); err != nil {
			if err == service.ErrOAuthBoundOther {
				apiErr(c, http.StatusBadRequest, err.Error())
				return
			}
			slog.Error("[AUTH] google bind failed", "uid", uid, "err", err)
			apiErr(c, http.StatusInternalServerError, "绑定失败，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, authdto.Message{Message: "Google 账号绑定成功"})
	}
}
