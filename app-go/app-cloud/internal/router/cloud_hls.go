package router

import (
	"errors"
	"net/http"
	"strings"

	"app-cloud/internal/middleware"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// getHLS returns the edge-playback descriptor and sets the short-lived
// hls_token cookie. The playlist/segments are served by OpenResty -> MinIO;
// app-cloud is not on the media byte path.
func getHLS(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := c.Param("upload_uuid")
		if d.HLS == nil {
			c.JSON(http.StatusOK, service.HLSPlayback{Ready: false, Status: "disabled"})
			return
		}
		// Stable per-browser binding: reuse the existing hls_ctx cookie (several
		// tabs share it) or mint one. It is embedded in the token so a token
		// copied from logs/storage is unusable without this cookie.
		bind, _ := c.Cookie("hls_ctx")
		if !validBindValue(bind) {
			bind = ""
			if fresh, genErr := d.HLS.NewBindValue(); genErr == nil {
				bind = fresh
			}
		}
		info, token, err := d.HLS.Playback(c.Request.Context(), uid, uploadUUID, bind)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		setHLSTokenCookie(c, info, token, bind)
		c.JSON(http.StatusOK, info)
	}
}

// retryHLS requeues a failed/failed-retry HLS packaging job. The response is
// the same descriptor as GET .../hls so the client keeps polling it.
func retryHLS(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		uploadUUID := c.Param("upload_uuid")
		if d.HLS == nil {
			c.JSON(http.StatusOK, service.HLSPlayback{Ready: false, Status: "disabled"})
			return
		}
		info, err := d.HLS.Retry(c.Request.Context(), uid, uploadUUID)
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "File not found")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		setHLSTokenCookie(c, info, "", "")
		c.JSON(http.StatusOK, info)
	}
}

// validBindValue accepts the hex binding values minted by the service; any
// client-supplied junk is replaced instead of being echoed into a cookie.
func validBindValue(v string) bool {
	if len(v) < 8 || len(v) > 128 {
		return false
	}
	for _, r := range v {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// setHLSTokenCookie issues the HttpOnly edge cookies scoped to /hls:
// hls_token is the Redis-backed capability; hls_ctx binds it to this browser so
// a token copied out of storage/logs cannot be replayed elsewhere.
func setHLSTokenCookie(c *gin.Context, info service.HLSPlayback, token, bind string) {
	if !info.Ready || token == "" {
		return
	}
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	set := func(name, value string) {
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     name,
			Value:    value,
			Path:     "/hls",
			MaxAge:   info.ExpiresIn,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}
	set("hls_token", token)
	if bind != "" {
		set("hls_ctx", bind)
	}
}
