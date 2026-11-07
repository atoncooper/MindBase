// Internal M2M face for the AI stack (app-ts): read-only knowledge scope.
// Guard = shared apikey (APISIX consumer key), mirroring app-pay's
// /internal/pay/* convention. Never exposed through nginx; APISIX routes it
// key-auth when the gateway path is preferred over direct container HTTP.
package router

import (
	"net/http"
	"strconv"
	"strings"

	"app-user/internal/router/middleware"

	"github.com/gin-gonic/gin"
)

func registerInternal(e *gin.Engine, d Deps) {
	g := e.Group("/internal/bili", middleware.APIKey(d.Cfg.Internal.APIKey))

	// GET /internal/bili/scope?uid= — folder→video→page tree (ASR state).
	g.GET("/scope", func(c *gin.Context) {
		uid, err := strconv.ParseInt(strings.TrimSpace(c.Query("uid")), 10, 64)
		if err != nil || uid <= 0 {
			apiErr(c, http.StatusBadRequest, "invalid uid")
			return
		}
		res, err := d.Scope.Scope(c.Request.Context(), uid)
		if err != nil {
			_ = serviceErr(c, err)
			return
		}
		writeJSON(c, http.StatusOK, res)
	})

	// GET /internal/bili/owns?uid=&bvid= — knowledge-delete ownership check.
	g.GET("/owns", func(c *gin.Context) {
		uid, err := strconv.ParseInt(strings.TrimSpace(c.Query("uid")), 10, 64)
		if err != nil || uid <= 0 {
			apiErr(c, http.StatusBadRequest, "invalid uid")
			return
		}
		bvid := strings.TrimSpace(c.Query("bvid"))
		if bvid == "" {
			apiErr(c, http.StatusBadRequest, "bvid required")
			return
		}
		ok, err := d.Scope.BvidBelongsToUser(c.Request.Context(), uid, bvid)
		if err != nil {
			_ = serviceErr(c, err)
			return
		}
		writeJSON(c, http.StatusOK, gin.H{"bvid": bvid, "belongs": ok})
	})
}
