package router

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/dto"

	"github.com/gin-gonic/gin"
)

// registerOrphanAdmin mounts the read-only orphan report endpoint plus the
// explicit, audited deletion endpoint. Both are authenticated with the same
// bearer token as the MinIO webhook (APPCLOUD__MINIO__EVENT_TOKEN) and are
// network-internal only (no edge/APISIX route).
func registerOrphanAdmin(e *gin.Engine, d Deps) {
	g := e.Group("/internal/cloud")
	g.GET("/orphans", listOrphans(d))
	g.POST("/orphans/delete", deleteOrphans(d))
}

func orphanAuth(c *gin.Context, token string) bool {
	if token == "" {
		c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "orphan admin disabled: token not configured"})
		return false
	}
	if !authorizedEventToken(c, token) {
		c.JSON(http.StatusUnauthorized, dto.ErrorResponse{Detail: "unauthorized"})
		return false
	}
	return true
}

func intQuery(c *gin.Context, key string, def, min, max int) int {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if max > 0 && n > max {
		return max
	}
	return n
}

// listOrphans — GET /internal/cloud/orphans?older_hours=&limit=&max_scan=
// Report only (never deletes). Bounded: max_scan caps bucket listing work.
func listOrphans(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !orphanAuth(c, d.Cfg.Minio.EventToken) {
			return
		}
		if d.Reconciler == nil {
			c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "reconciler disabled"})
			return
		}
		// older_hours=0 is allowed: inspect all ages (admin one-off checks).
		hours := intQuery(c, "older_hours", d.Cfg.Orphan.GraceHours, 0, 24*365)
		limit := intQuery(c, "limit", 200, 1, 1000)
		maxScan := intQuery(c, "max_scan", 50000, 100, 500000)

		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()
		orphans, err := d.Reconciler.ListOrphans(ctx, time.Now().Add(-time.Duration(hours)*time.Hour), maxScan, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, dto.ErrorResponse{Detail: err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"orphans":      orphans,
			"count":        len(orphans),
			"older_hours":  hours,
			"auto_delete":  d.Cfg.Orphan.AutoDelete,
			"grace_hours":  d.Cfg.Orphan.GraceHours,
			"generated_at": time.Now().UTC(),
		})
	}
}

type orphanDeleteRequest struct {
	Keys   []string `json:"keys"`
	DryRun *bool    `json:"dry_run"` // default true: preview only
}

// deleteOrphans — POST /internal/cloud/orphans/delete
// Body: {"keys":["<uid>/<upload_uuid>/file.ext"],"dry_run":true}
// Every key is re-verified as an orphan (key shape + no DB row + object exists)
// immediately before deletion; the action is logged for audit. dry_run defaults
// to true so a caller must opt in explicitly.
func deleteOrphans(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !orphanAuth(c, d.Cfg.Minio.EventToken) {
			return
		}
		if d.Reconciler == nil {
			c.JSON(http.StatusServiceUnavailable, dto.ErrorResponse{Detail: "reconciler disabled"})
			return
		}
		var req orphanDeleteRequest
		if err := c.ShouldBindJSON(&req); err != nil || len(req.Keys) == 0 {
			c.JSON(http.StatusUnprocessableEntity, dto.ErrorResponse{Detail: "keys is required"})
			return
		}
		if len(req.Keys) > 1000 {
			c.JSON(http.StatusUnprocessableEntity, dto.ErrorResponse{Detail: "too many keys (max 1000 per call)"})
			return
		}
		dryRun := true
		if req.DryRun != nil {
			dryRun = *req.DryRun
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()
		deleted := 0
		results := make([]gin.H, 0, len(req.Keys))
		for _, key := range req.Keys {
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			if dryRun {
				results = append(results, gin.H{"key": key, "would_delete": true})
				continue
			}
			ok, err := d.Reconciler.DeleteOrphan(ctx, key)
			if err != nil {
				results = append(results, gin.H{"key": key, "deleted": false, "error": err.Error()})
				continue
			}
			if ok {
				deleted++
			}
			results = append(results, gin.H{"key": key, "deleted": ok})
		}
		if !dryRun {
			slog.Warn("[ORPHAN_ADMIN] orphan deletion executed",
				"requested", len(req.Keys), "deleted", deleted, "ip", c.ClientIP())
		}
		c.JSON(http.StatusOK, gin.H{
			"dry_run": dryRun,
			"deleted": deleted,
			"results": results,
		})
	}
}
