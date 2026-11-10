// Avatar object storage (internal M2M): the account domain (app-user) owns
// profile metadata but must not hold MinIO credentials. app-cloud owns object
// storage and exposes these two internal endpoints for avatar upload/read.
package router

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/middleware"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxAvatarBytes = 2 * 1024 * 1024

var avatarContentTypes = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
}

// registerInternalAvatar mounts /internal/cloud/avatar on the existing
// apikey + X-Uid guarded internal group.
func registerInternalAvatar(g *gin.RouterGroup, d Deps) {
	g.POST("/avatar", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		if uid <= 0 {
			apiErr(c, http.StatusBadRequest, "missing uid")
			return
		}
		if d.Minio == nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		contentType := strings.TrimSpace(c.GetHeader("Content-Type"))
		if i := strings.IndexByte(contentType, ';'); i >= 0 {
			contentType = strings.TrimSpace(contentType[:i])
		}
		ext, ok := avatarContentTypes[contentType]
		if !ok {
			apiErr(c, http.StatusBadRequest, "仅支持 PNG / JPG / WebP 图片")
			return
		}
		data, err := io.ReadAll(io.LimitReader(c.Request.Body, maxAvatarBytes+1))
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusBadRequest, "空文件")
			return
		}
		if len(data) > maxAvatarBytes {
			apiErr(c, http.StatusBadRequest, "头像大小超过 2MB 限制")
			return
		}
		key := "avatars/" + strconv.FormatInt(uid, 10) + "/" + uuid.NewString()[:7] + "." + ext
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		if err := d.Minio.PutObject(ctx, key, data, contentType); err != nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		c.JSON(http.StatusOK, gin.H{"key": key, "content_type": contentType, "size": len(data)})
	})

	g.GET("/avatar", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		key := strings.TrimSpace(c.Query("key"))
		if uid <= 0 || key == "" {
			apiErr(c, http.StatusBadRequest, "missing key")
			return
		}
		if !strings.HasPrefix(key, "avatars/"+strconv.FormatInt(uid, 10)+"/") {
			apiErr(c, http.StatusNotFound, "头像不存在")
			return
		}
		if d.Minio == nil {
			apiErr(c, http.StatusServiceUnavailable, "对象存储不可用")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		contentType, data, err := d.Minio.GetObjectWithType(ctx, key)
		if err != nil || len(data) == 0 {
			apiErr(c, http.StatusNotFound, "头像不存在")
			return
		}
		if contentType == "" {
			contentType = "image/jpeg"
		}
		c.Header("Cache-Control", "public, max-age=86400")
		c.Data(http.StatusOK, contentType, data)
	})
}
