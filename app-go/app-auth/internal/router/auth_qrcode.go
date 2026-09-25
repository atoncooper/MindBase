package router

import (
	"log/slog"
	"net/http"
	"strconv"

	"app-auth/internal/service"

	"github.com/gin-gonic/gin"
)

// qrcodePool is package-level (one process, one pool) — same lifecycle as
// the Python module-level dict.
var qrcodePool = newQRCodeClientPool()

// getCaptcha — GET /auth/captcha.
func getCaptcha(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		res, err := d.Captcha.Generate(c.Request.Context())
		if err != nil {
			slog.Error("[AUTH] captcha generate failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "验证码生成失败，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"captcha_id":   res.CaptchaID,
			"image_base64": res.ImageBase64,
			"expires_in":   res.ExpiresIn,
			"required":     res.Required,
		})
	}
}

// generateQRCode — GET /auth/qrcode.
func generateQRCode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		passport := service.NewBilibiliPassport()
		res, err := passport.GenerateQRCode(c.Request.Context())
		if err != nil {
			slog.Error("[AUTH] generate qrcode failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "二维码生成失败，请稍后重试")
			return
		}
		qrcodePool.put(res.QRCodeKey, passport)
		c.JSON(http.StatusOK, gin.H{
			"qrcode_key":          res.QRCodeKey,
			"qrcode_url":          res.QRCodeURL,
			"qrcode_image_base64": res.QRCodeImageB64,
		})
	}
}

// pollQRCode — GET /auth/qrcode/poll/{qrcode_key}?purpose=
//
// On confirmed: bind (purpose=bind, requires session) or ensure user
// (login), then return user_info (+ session_id/session_token for login).
func pollQRCode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := normalizeKey(c.Param("qrcode_key"))
		purpose := c.Query("purpose")
		tokenStr := extractToken(c)

		passport := qrcodePool.get(key)
		shouldDrop := true // fallback clients are never re-pooled
		if passport == nil {
			slog.Warn("[AUTH] qrcode key not found in pool (restart?), using fallback client",
				"key_prefix", key[:min(12, len(key))])
			passport = service.NewBilibiliPassport()
		}
		result, err := passport.PollQRCodeStatus(c.Request.Context(), key)
		if err != nil {
			if shouldDrop {
				qrcodePool.pop(key)
			}
			slog.Error("[AUTH] poll qrcode failed", "err", err)
			apiErr(c, http.StatusInternalServerError, "二维码轮询失败，请稍后重试")
			return
		}

		resp := gin.H{"status": result.Status, "message": result.Message}
		if result.Status == "confirmed" {
			biliMid := int64(0)
			if midStr := result.Cookies["DedeUserID"]; midStr != "" {
				biliMid, _ = strconv.ParseInt(midStr, 10, 64)
			}
			nickname, avatar := "", ""
			if info, err := passport.GetUserInfo(result.Cookies["SESSDATA"], result.Cookies["bili_jct"], result.Cookies["DedeUserID"]); err == nil {
				// mid from user_info is the authoritative source
				if info.Mid != 0 && info.Mid != biliMid {
					slog.Info("[AUTH] corrected bili_mid", "from", biliMid, "to", info.Mid)
					biliMid = info.Mid
				}
				nickname, avatar = info.Uname, info.Face
			} else {
				slog.Warn("[AUTH] fetch bilibili user info failed", "err", err)
			}
			if biliMid == 0 {
				apiErr(c, http.StatusInternalServerError, "无法识别B站用户身份")
				return
			}

			providerData := &service.ProviderData{
				AccessToken:  result.Cookies["SESSDATA"],
				RefreshToken: result.RefreshToken,
				RawData:      "",
			}
			profile := &service.ProfilePatch{}
			if nickname != "" {
				profile.Nickname = &nickname
			}
			if avatar != "" {
				profile.Avatar = &avatar
			}
			isBinding := purpose == "bind"
			currentUID := int64(0)
			if tokenStr != "" {
				currentUID = d.Tokens.Validate(c.Request.Context(), tokenStr)
			}
			if isBinding && tokenStr == "" {
				apiErr(c, http.StatusUnauthorized, "未提供认证 token")
				return
			}
			if (isBinding || tokenStr != "") && currentUID == 0 {
				apiErr(c, http.StatusUnauthorized, "token 无效或已过期")
				return
			}

			if currentUID != 0 {
				if err := d.Auth.BindOAuthToUser(currentUID, "bilibili", strconv.FormatInt(biliMid, 10), providerData, profile); err != nil {
					if err == service.ErrOAuthBoundOther {
						apiErr(c, http.StatusBadRequest, err.Error())
						return
					}
					slog.Error("[AUTH] bind bilibili failed", "uid", currentUID, "err", err)
					apiErr(c, http.StatusInternalServerError, "绑定失败，请稍后重试")
					return
				}
				roles, _ := d.RBAC.GetUserRoles(c.Request.Context(), currentUID)
				resp["user_info"] = gin.H{
					"uid":   currentUID,
					"mid":   biliMid,
					"uname": nilIfEmpty(nickname),
					"face":  nilIfEmpty(avatar),
					"roles": rolesOrFree(roles),
				}
			} else {
				ip, deviceID, ua, meta := requestContext(c)
				ipPtr, devPtr, uaPtr := ip, deviceID, ua
				uid, sessionToken, err := d.Auth.EnsureUserFromOAuth("bilibili",
					strconv.FormatInt(biliMid, 10), providerData, profile,
					&devPtr, &ipPtr, &uaPtr)
				if err != nil {
					slog.Error("[AUTH] ensure user failed", "err", err)
					apiErr(c, http.StatusInternalServerError, "登录失败，请稍后重试")
					return
				}
				d.Auth.RecordDevice(uid, deviceID, meta)
				roles, _ := d.RBAC.GetUserRoles(c.Request.Context(), uid)
				resp["session_id"] = sessionToken
				resp["user_info"] = gin.H{
					"uid":           uid,
					"mid":           biliMid,
					"uname":         nilIfEmpty(nickname),
					"face":          nilIfEmpty(avatar),
					"roles":         rolesOrFree(roles),
					"session_token": sessionToken,
				}
			}
		}

		// Clean up the pooled client on terminal states.
		if result.Status != "waiting" {
			qrcodePool.pop(key)
		} else if !shouldDrop {
			qrcodePool.put(key, passport)
		}
		c.JSON(http.StatusOK, resp)
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func rolesOrFree(roles []string) []string {
	if len(roles) == 0 {
		return []string{"free"}
	}
	return roles
}
