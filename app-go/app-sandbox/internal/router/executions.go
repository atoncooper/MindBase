package router

import "github.com/gin-gonic/gin"

// registerExecutions wires the public /v1 execution endpoints. The collection
// route is registered before /:id so the intent reads top-down; Gin matches
// literal segments before params either way.
func registerExecutions(g *gin.RouterGroup, d Deps) {
	g.GET("/executions", func(c *gin.Context) { listExecutions(c, d) })
	g.POST("/executions", func(c *gin.Context) { createExecution(c, d) })
	g.GET("/executions/:id", func(c *gin.Context) { getExecution(c, d) })
	g.GET("/executions/:id/events", func(c *gin.Context) { executionEvents(c, d) })
	g.POST("/executions/:id/cancel", func(c *gin.Context) { cancelExecution(c, d) })
	g.GET("/executions/:id/output", func(c *gin.Context) { executionOutput(c, d) })
	g.GET("/executions/:id/artifacts/read", func(c *gin.Context) { artifactRead(c, d) })
	g.GET("/runtime", func(c *gin.Context) { runtimeInfo(c, d) })
	g.GET("/files/read", func(c *gin.Context) { readFile(c, d) })
	g.POST("/files/write", func(c *gin.Context) { writeFile(c, d) })
	// Project cascade (called by app-ts before deleting a project row).
	g.DELETE("/leases", func(c *gin.Context) { releaseMyProjectLeases(c, d) })
}
