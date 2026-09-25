package router

import (
	"log/slog"
	"net/http"
	"time"

	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
)

// wechatQROptions — GET /auth/wechat/qrcode: wxLogin.js init params + a
// one-time state. enabled=false when unconfigured or Redis can't hold the
// state (frontend hides the WeChat tab).
func wechatQROptions(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		empty := gin.H{"enabled": false, "app_id": "", "redirect_uri": "", "state": ""}
		if !d.Cfg.WeChat.Enabled {
			c.JSON(http.StatusOK, empty)
			return
		}
		purpose := service.WeChatStateLogin
		if c.Query("purpose") == "bind" {
			uid := d.Tokens.Validate(c.Request.Context(), extractToken(c))
			if uid == 0 {
				apiErr(c, http.StatusUnauthorized, "绑定操作需要登录")
				return
			}
			purpose = service.WeChatStateBind
		}
		state, err := d.WeChat.IssueState(c.Request.Context(), purpose)
		if err != nil {
			slog.Warn("[AUTH] wechat state issue failed (redis down?)", "err", err)
			c.JSON(http.StatusOK, empty)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"enabled":      true,
			"app_id":       d.Cfg.WeChat.AppID,
			"redirect_uri": d.Cfg.WeChat.RedirectURI,
			"state":        state,
		})
	}
}

// resolveWechatIdentity — consume state, exchange code, best-effort profile.
func resolveWechatIdentity(d Deps, c *gin.Context, code, state, purpose string) (*service.WeChatToken, *service.ProfilePatch, bool) {
	if !d.Cfg.WeChat.Enabled {
		apiErr(c, http.StatusBadRequest, "微信登录未启用")
		return nil, nil, false
	}
	if !d.WeChat.ConsumeState(c.Request.Context(), state, purpose) {
		apiErr(c, http.StatusBadRequest, "登录状态已过期，请重新扫码")
		return nil, nil, false
	}
	tok, err := d.WeChat.ExchangeCode(c.Request.Context(), code)
	if err != nil {
		apiErr(c, http.StatusBadGateway, err.Error())
		return nil, nil, false
	}
	if tok.OpenID == "" {
		slog.Error("[AUTH] wechat exchange returned no openid")
		apiErr(c, http.StatusBadGateway, "微信登录失败，请重试")
		return nil, nil, false
	}
	profile := &service.ProfilePatch{}
	if info, err := d.WeChat.GetUserProfile(c.Request.Context(), tok.AccessToken, tok.OpenID); err == nil {
		if info.Nickname != "" {
			profile.Nickname = &info.Nickname
		}
		if info.HeadImgURL != "" {
			profile.Avatar = &info.HeadImgURL
		}
	} else {
		slog.Warn("[AUTH] wechat userinfo failed, continuing without profile")
	}
	return tok, profile, true
}

func wechatProviderData(tok *service.WeChatToken) *service.ProviderData {
	data := &service.ProviderData{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		UnionID:      tok.UnionID,
	}
	if tok.ExpiresIn > 0 {
		exp := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		data.ExpiresAt = &exp
	}
	return data
}

// wechatLogin — POST /auth/wechat/login (register on first use).
func wechatLogin(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Code  string `json:"code" binding:"required"`
		State string `json:"state" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		tok, profile, ok := resolveWechatIdentity(d, c, req.Code, req.State, service.WeChatStateLogin)
		if !ok {
			return
		}
		ip, deviceID, ua, meta := requestContext(c)
		ipPtr, devPtr, uaPtr := ip, deviceID, ua
		uid, token, err := d.Auth.EnsureUserFromOAuth("wechat", tok.OpenID,
			wechatProviderData(tok), profile, &devPtr, &ipPtr, &uaPtr)
		if err != nil {
			slog.Error("[AUTH] wechat login failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "微信登录失败，请稍后重试")
			return
		}
		d.Auth.RecordDevice(uid, deviceID, meta)
		slog.Info("[AUTH] wechat login ok", "uid", uid)
		expires := time.Now().AddDate(0, 0, d.Cfg.Auth.TokenTTLDays)
		tokenResponse(d, c, uid, token, &expires)
	}
}

// wechatBind — POST /auth/wechat/bind (authenticated; settings page).
func wechatBind(d Deps) gin.HandlerFunc {
	type reqBody struct {
		Code  string `json:"code" binding:"required"`
		State string `json:"state" binding:"required"`
	}
	return func(c *gin.Context) {
		var req reqBody
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		tok, profile, ok := resolveWechatIdentity(d, c, req.Code, req.State, service.WeChatStateBind)
		if !ok {
			return
		}
		uid := currentUID(c)
		if err := d.Auth.BindOAuthToUser(uid, "wechat", tok.OpenID, wechatProviderData(tok), profile); err != nil {
			if err == service.ErrOAuthBoundOther {
				apiErr(c, http.StatusBadRequest, err.Error())
				return
			}
			slog.Error("[AUTH] wechat bind failed", "uid", uid, "err", err)
			apiErr(c, http.StatusInternalServerError, "绑定失败，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "微信账号绑定成功"})
	}
}
