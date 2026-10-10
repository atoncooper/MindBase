// /preferences + /wallpaper — user KV preferences and wallpaper upload/serving
// (Python routers/preferences.py + wallpaper.py parity). Values are JSON
// strings in user_preferences; the "wallpaper" key is written by the
// wallpaper endpoints themselves. Identity = gateway-injected X-Uid.
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

	"app-settings/internal/db"
	"app-settings/internal/minio"
	"app-settings/internal/repo"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// SetMinioClient wires the storage handle from main (nil = wallpaper 503).
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
		raw, err := repo.GetAllPreferences(c.Request.Context(), db.DB, uid)
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
		for key, value := range body.Preferences {
			encoded, err := json.Marshal(value)
			if err != nil {
				apiErr(c, http.StatusBadRequest, "偏好值必须可序列化为 JSON")
				return
			}
			if err := repo.UpsertPreference(c.Request.Context(), db.DB, uid, key, string(encoded)); err != nil {
				apiErr(c, http.StatusInternalServerError, "内部错误")
				return
			}
		}
		raw, err := repo.GetAllPreferences(c.Request.Context(), db.DB, uid)
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

// ── wallpaper ────────────────────────────────────────────────────────

var wallpaperPresets = []gin.H{
	{"id": "default", "name": "默认风景", "type": "image"},
	{"id": "sonoma", "name": "Sonoma", "type": "image"},
	{"id": "monterey", "name": "Monterey", "type": "image"},
	{"id": "ventura", "name": "Ventura", "type": "image"},
	{"id": "sonoma-dynamic", "name": "Sonoma 动态", "type": "video"},
	{"id": "monterey-dynamic", "name": "Monterey 动态", "type": "video"},
	{"id": "ventura-dynamic", "name": "Ventura 动态", "type": "video"},
}

type wallpaperPref struct {
	Source  string `json:"source"`
	Key     string `json:"key"`
	Version int    `json:"version"`
	Type    string `json:"type,omitempty"`
}

func readWallpaperPref(c *gin.Context, uid int64) *wallpaperPref {
	raw, err := repo.GetAllPreferences(c.Request.Context(), db.DB, uid)
	if err != nil {
		return nil
	}
	value, ok := raw["wallpaper"]
	if !ok {
		return nil
	}
	var pref wallpaperPref
	if err := json.Unmarshal([]byte(value), &pref); err != nil {
		return nil
	}
	return &pref
}

func writeWallpaperPref(c *gin.Context, uid int64, pref wallpaperPref) error {
	encoded, err := json.Marshal(pref)
	if err != nil {
		return err
	}
	return repo.UpsertPreference(c.Request.Context(), db.DB, uid, "wallpaper", string(encoded))
}

// deletePreviousCustomObject removes the old custom wallpaper (best-effort).
func deletePreviousCustomObject(ctx context.Context, pref *wallpaperPref) {
	if pref == nil || pref.Source != "custom" || pref.Key == "" || minioStore == nil {
		return
	}
	if err := minioStore.Remove(ctx, pref.Key); err != nil {
		slog.Warn("[WALLPAPER] previous object removal failed", "key", pref.Key, "err", err)
	}
}

func registerWallpaper(e *gin.Engine) {
	g := e.Group("/wallpaper")

	g.GET("/presets", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"presets": wallpaperPresets})
	})

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
			"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4",
		}
		ext, supported := allowed[contentType]
		if !supported {
			apiErr(c, http.StatusBadRequest, "不支持的壁纸类型: "+contentType)
			return
		}
		data, err := io.ReadAll(file)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusBadRequest, "空文件")
			return
		}
		if len(data) > 50*1024*1024 {
			apiErr(c, http.StatusBadRequest, "壁纸大小超过 50MB 限制")
			return
		}
		objectKey := "wallpapers/" + itoa64(uid) + "/" + uuid.NewString()[:7] + "." + ext
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		if err := minioStore.Put(ctx, objectKey, data, contentType); err != nil {
			slog.Error("[WALLPAPER] upload failed", "err", err)
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		previous := readWallpaperPref(c, uid)
		deletePreviousCustomObject(ctx, previous)
		version := 1
		if previous != nil {
			version = previous.Version + 1
		}
		pref := wallpaperPref{Source: "custom", Key: objectKey, Version: version, Type: "image"}
		if strings.HasPrefix(contentType, "video/") {
			pref.Type = "video"
		}
		if err := writeWallpaperPref(c, uid, pref); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		c.JSON(http.StatusOK, gin.H{"wallpaper": pref})
	})

	g.POST("/preset", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var body struct {
			PresetID string `json:"preset_id"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.PresetID) == "" {
			apiErr(c, http.StatusBadRequest, "preset_id 必填")
			return
		}
		var preset gin.H
		for _, p := range wallpaperPresets {
			if p["id"] == body.PresetID {
				preset = p
				break
			}
		}
		if preset == nil {
			apiErr(c, http.StatusNotFound, "未知预设: "+body.PresetID)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		previous := readWallpaperPref(c, uid)
		deletePreviousCustomObject(ctx, previous)
		pref := wallpaperPref{Source: "preset", Key: body.PresetID, Version: 1, Type: preset["type"].(string)}
		if err := writeWallpaperPref(c, uid, pref); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		c.JSON(http.StatusOK, gin.H{"wallpaper": pref})
	})

	// No auth (treated like the avatar route): only wallpapers/ keys served.
	g.GET("/file/*object_key", func(c *gin.Context) {
		objectKey := strings.TrimPrefix(c.Param("object_key"), "/")
		if !strings.HasPrefix(objectKey, "wallpapers/") || minioStore == nil {
			apiErr(c, http.StatusNotFound, "壁纸不存在")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()
		contentType, data, err := minioStore.Get(ctx, objectKey)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusNotFound, "壁纸不存在")
			return
		}
		if contentType == "" {
			contentType = "image/jpeg"
		}
		c.Header("Cache-Control", "public, max-age=604800")
		c.Data(http.StatusOK, contentType, data)
	})
}

func itoa64(v int64) string {
	return strconv.FormatInt(v, 10)
}

// ── avatar ───────────────────────────────────────────────────────────
//
// 头像对象存储（app-settings 只负责文件；profile.avatar 字段本身归 app-auth，
// 前端上传拿到 URL 后再走 /auth profile 更新）。镜像 wallpaper 的上传/直读
// 模式：POST /avatar/upload（Bearer）→ GET /avatar/file/*（公开 <img> 直读，
// lenient verify 无凭证放行，与 wallpaper/file 语义一致）。旧头像对象不做
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
		// <img src> 无需鉴权头；存入 users.avatar（app-auth）。
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
