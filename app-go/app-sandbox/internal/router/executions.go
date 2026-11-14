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
}
