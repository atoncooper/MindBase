package router

import "github.com/gin-gonic/gin"

// registerAdmin wires the internal admin API (/internal/admin/*) used by the
// app-admin console. It is registered on a fresh group so the X-Admin-Token
// middleware never applies to /v1 or the legacy /internal routes.
func registerAdmin(e *gin.Engine, d Deps) {
	g := e.Group("/internal/admin", adminTokenAuth(d.Cfg))
	g.GET("/overview", func(c *gin.Context) { adminOverview(c, d) })
	g.GET("/executions", func(c *gin.Context) { adminExecutions(c, d) })
	g.GET("/executions/:id", func(c *gin.Context) { adminExecutionDetail(c, d) })
	g.POST("/executions/:id/cancel", func(c *gin.Context) { adminCancelExecution(c, d) })
	g.GET("/leases", func(c *gin.Context) { adminLeases(c, d) })
	g.DELETE("/leases/:id", func(c *gin.Context) { adminReleaseLease(c, d) })
	g.GET("/quota", func(c *gin.Context) { adminQuota(c, d) })
	g.GET("/audit", func(c *gin.Context) { adminAudit(c, d) })
	g.GET("/config", func(c *gin.Context) { adminConfig(c, d) })
}
