// /preferences + /avatar — user KV preferences and avatar upload/serving.
// Values are JSON strings in user_preferences. Identity = gateway-injected
// X-Uid. (The legacy wallpaper feature was removed; only avatars remain.)
package router

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-user/internal/infra/minio"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// SetMinioStore wires the storage handle from main (nil = avatar upload 503).
var minioStore *minio.Store

func SetMinioStore(s *minio.Store) { minioStore = s }

// ── preferences ──────────────────────────────────────────────────────

func registerPreferences(e *gin.Engine) {
	g := e.Group("/preferences")

	g.GET("", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		raw, err := settingsSvc.GetAllPreferences(c.Request.Context(), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		prefs := make(map[string]interface{}, len(raw))
		for k, v := range raw {
			var decoded interface{}
			if err := json.Unmarshal([]byte(v), &decoded); err != nil {
				decoded = v // non-JSON value: pass the raw string through
			}
			prefs[k] = decoded
		}
		c.JSON(http.StatusOK, gin.H{"preferences": prefs})
	})

	g.PATCH("", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var body struct {
			Preferences map[string]interface{} `json:"preferences"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.Preferences == nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		encodedPrefs := make(map[string]string, len(body.Preferences))
		for key, value := range body.Preferences {
			encoded, err := json.Marshal(value)
			if err != nil {
				apiErr(c, http.StatusBadRequest, "偏好值必须可序列化为 JSON")
				return
			}
			encodedPrefs[key] = string(encoded)
		}
		if err := settingsSvc.UpsertPreferences(c.Request.Context(), uid, encodedPrefs); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		raw, err := settingsSvc.GetAllPreferences(c.Request.Context(), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		prefs := make(map[string]interface{}, len(raw))
		for k, v := range raw {
			var decoded interface{}
			if err := json.Unmarshal([]byte(v), &decoded); err != nil {
				decoded = v
			}
			prefs[k] = decoded
		}
		c.JSON(http.StatusOK, gin.H{"preferences": prefs})
	})
}

func itoa64(v int64) string {
	return strconv.FormatInt(v, 10)
}

// ── avatar ───────────────────────────────────────────────────────────
//
// 头像对象存储（settings 域只负责文件；profile.avatar 字段本身归 auth 域，
// 前端上传拿到 URL 后再走 /auth profile 更新）。上传/直读模式：
// POST /avatar/upload（Bearer）→ GET /avatar/file/*（公开 <img> 直读，
// lenient verify 无凭证放行）。旧头像对象不做
// 服务端回收（无跨服务记录；2MB 小对象、变更低频，放任 MinIO 侧生命周期）。

func registerAvatar(e *gin.Engine) {
	g := e.Group("/avatar")

	g.POST("/upload", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if minioStore == nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		file, header, err := c.Request.FormFile("file")
		if err != nil || header == nil {
			apiErr(c, http.StatusBadRequest, "空文件")
			return
		}
		defer file.Close()
		contentType := header.Header.Get("Content-Type")
		allowed := map[string]string{
			"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
		}
		ext, supported := allowed[contentType]
		if !supported {
			apiErr(c, http.StatusBadRequest, "仅支持 PNG / JPG / WebP 图片")
			return
		}
		data, err := io.ReadAll(file)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusBadRequest, "空文件")
			return
		}
		if len(data) > 2*1024*1024 {
			apiErr(c, http.StatusBadRequest, "头像大小超过 2MB 限制")
			return
		}
		objectKey := "avatars/" + itoa64(uid) + "/" + uuid.NewString()[:7] + "." + ext
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		if err := minioStore.Put(ctx, objectKey, data, contentType); err != nil {
			slog.Error("[AVATAR] upload failed", "err", err)
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		// URL 为站内相对路径：由 nginx /avatar/ → APISIX → 本服务公开直读，
		// <img src> 无需鉴权头；存入 users.avatar（app-user）。
		c.JSON(http.StatusOK, gin.H{"url": "/avatar/file/" + objectKey})
	})

	g.GET("/file/*object_key", func(c *gin.Context) {
		objectKey := strings.TrimPrefix(c.Param("object_key"), "/")
		if !strings.HasPrefix(objectKey, "avatars/") || minioStore == nil {
			apiErr(c, http.StatusNotFound, "头像不存在")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		contentType, data, err := minioStore.Get(ctx, objectKey)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusNotFound, "头像不存在")
			return
		}
		if contentType == "" {
			contentType = "image/jpeg"
		}
		// 头像变更频率低但可见性强：短缓存，避免改头像后长期显示旧图。
		c.Header("Cache-Control", "public, max-age=86400")
		c.Data(http.StatusOK, contentType, data)
	})
}
