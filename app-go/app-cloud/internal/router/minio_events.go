package router

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"app-cloud/internal/dto"

	"github.com/gin-gonic/gin"
)

// registerMinioEvents mounts the MinIO bucket-notification webhook. It is
// deliberately OUTSIDE the RequireInternalKey/RequireInternalUID group: MinIO
// sends only "Authorization: Bearer <auth_token>" (no X-Uid), so the endpoint
// authenticates with its own token (APPCLOUD__MINIO__EVENT_TOKEN).
func registerMinioEvents(e *gin.Engine, d Deps) {
	e.POST("/internal/cloud/minio/events", minioEventWebhook(d))
}

// minioEventPayload is the subset of MinIO's notification JSON we consume.
type minioEventPayload struct {
	EventName string        `json:"EventName"`
	Records   []minioRecord `json:"Records"`
}

// authorizedEventToken reports whether the request carries the configured
// bearer token (constant-time compare). Shared by the MinIO webhook and the
// orphan-admin endpoints.
func authorizedEventToken(c *gin.Context, token string) bool {
	if token == "" {
		return false
	}
	supplied := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) == 1
}

type minioRecord struct {
	EventName string `json:"eventName"`
	S3        struct {
		Bucket struct {
			Name string `json:"name"`
		} `json:"bucket"`
		Object struct {
			Key  string `json:"key"`
			Size int64  `json:"size"`
			ETag string `json:"eTag"`
		} `json:"object"`
	} `json:"s3"`
}

func minioEventWebhook(d Deps) gin.HandlerFunc {
	token := strings.TrimSpace(d.Cfg.Minio.EventToken)
	return func(c *gin.Context) {
		if token == "" {
			// Fail closed: no token configured means the settlement endpoint
			// must not accept unauthenticated writes.
			c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "minio event settlement disabled"})
			return
		}
		supplied := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		if subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) != 1 {
			c.JSON(http.StatusUnauthorized, dto.ErrorResponse{Detail: "unauthorized"})
			return
		}
		if d.Upload == nil {
			c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "upload service disabled"})
			return
		}

		var payload minioEventPayload
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, dto.ErrorResponse{Detail: "invalid event payload"})
			return
		}

		processed := 0
		for _, rec := range payload.Records {
			name := rec.EventName
			if name == "" {
				name = payload.EventName
			}
			// Only multipart completion settles an upload (chunk PUTs and
			// ordinary object puts are ignored; the reconciler handles stale
			// objects separately).
			if !strings.Contains(name, "CompleteMultipartUpload") {
				continue
			}
			key := rec.S3.Object.Key
			if unescaped, err := url.QueryUnescape(key); err == nil {
				key = unescaped
			}
			if key == "" {
				continue
			}
			if err := d.Upload.FinalizeFromEvent(c.Request.Context(), key, rec.S3.Object.ETag); err != nil {
				// Transient (DB/MinIO) failure → non-2xx so MinIO retries the
				// webhook; settlement is idempotent, retries are safe.
				slog.Error("[CLOUD_EVENT] settlement failed", "object_key", key, "err", err)
				c.JSON(http.StatusInternalServerError, dto.ErrorResponse{Detail: "settlement failed"})
				return
			}
			// The client-complete path enqueues HLS directly; if the MinIO
			// bucket notification won the settlement race, enqueue here too.
			if d.HLS != nil {
				if uid, uploadUUID, ok := parseUploadObjectKey(key); ok {
					d.HLS.Enqueue(c.Request.Context(), uid, uploadUUID)
				}
			}
			processed++
		}
		c.JSON(http.StatusOK, gin.H{"processed": processed})
	}
}

// parseUploadObjectKey extracts uid/uploadUuid from the object key shape
// "{uid}/{uploadUuid}/file{ext}". It returns false for unrelated keys.
func parseUploadObjectKey(key string) (int64, string, bool) {
	parts := strings.SplitN(strings.TrimPrefix(key, "/"), "/", 3)
	if len(parts) < 3 {
		return 0, "", false
	}
	uid, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || uid <= 0 || parts[1] == "" {
		return 0, "", false
	}
	return uid, parts[1], true
}
