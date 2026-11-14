package router

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-sandbox/internal/dto"
	"app-sandbox/internal/model"

	"github.com/gin-gonic/gin"
)

// ── liveness / readiness / metrics ───────────────────────────────────

func registerOps(e *gin.Engine, d Deps) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, dto.HealthResponse{Status: "ok", Service: "app-sandbox", Runtime: d.RuntimeName})
	})
	e.GET("/ready", func(c *gin.Context) {
		if d.PingDB != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			defer cancel()
			if err := d.PingDB(ctx); err != nil {
				c.JSON(http.StatusServiceUnavailable, dto.DegradedMySQLResponse{Status: "degraded", MySQL: "down"})
				return
			}
		}
		if d.RuntimeProbe != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
			defer cancel()
			if err := d.RuntimeProbe(ctx); err != nil {
				c.JSON(http.StatusServiceUnavailable, dto.DegradedRuntimeResponse{Status: "degraded", Runtime: "down"})
				return
			}
		}
		c.JSON(http.StatusOK, dto.ReadyResponse{Status: "ready", Runtime: d.RuntimeName})
	})
	e.GET("/metrics", func(c *gin.Context) {
		if d.Metrics == nil {
			c.String(http.StatusOK, "")
			return
		}
		c.Data(http.StatusOK, "text/plain; version=0.0.4; charset=utf-8", []byte(d.Metrics.Render()))
	})
}

// ── internal lease administration ────────────────────────────────────

func registerInternal(g *gin.RouterGroup, d Deps) {
	g.GET("/leases", func(c *gin.Context) { listLeases(c, d) })
	g.DELETE("/leases/:id", func(c *gin.Context) { releaseLease(c, d) })
}

func listLeases(c *gin.Context, d Deps) {
	limit := parseLimit(c.Query("limit"))
	states := parseStates(c.Query("state"))
	ctx := c.Request.Context()

	if rawUID := strings.TrimSpace(c.Query("uid")); rawUID != "" {
		uid, err := strconv.ParseInt(rawUID, 10, 64)
		if err != nil || uid <= 0 {
			apiErr(c, http.StatusBadRequest, "uid 无效")
			return
		}
		leases, lerr := d.Leases.ListByUID(ctx, uid, limit)
		if lerr != nil {
			respondError(c, lerr)
			return
		}
		c.JSON(http.StatusOK, dto.NewLeaseListResponse(leases))
		return
	}
	if len(states) == 0 {
		states = model.LeaseActiveStates
	}
	leases, err := d.Leases.ListByStates(ctx, states, limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.NewLeaseListResponse(leases))
}

func releaseLease(c *gin.Context, d Deps) {
	if _, err := d.Leases.Release(c.Request.Context(), c.Param("id"), "manual", currentRequestID(c)); err != nil {
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func parseLimit(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 100
	}
	if n > 500 {
		return 500
	}
	return n
}

func parseStates(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
