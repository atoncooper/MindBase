// /settings/mcp/servers + /internal/settings/mcp — per-user MCP connections
// (settings domain). Identity on the user face = gateway-injected X-Uid
// (APISIX forward-auth); the M2M face is guarded by the shared internal key
// and is the ONLY one that returns plaintext API keys (app-ts consumes it).
//
// MCP protocol work (tools/list, tools/call) stays in app-ts: this service
// stores user configuration and the discovered-tool cache written back by
// app-ts, nothing else.
package router

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	settingsdto "app-user/internal/dto/settings"
	"app-user/internal/router/middleware"
	settingsservice "app-user/internal/service/settings"

	"github.com/gin-gonic/gin"
)

// mcpErr maps service errors to HTTP statuses without leaking internals.
func mcpErr(c *gin.Context, err error) {
	var invalid *settingsservice.MCPValidationError
	var upstream *settingsservice.MCPOAuthUpstreamError
	switch {
	case errors.As(err, &upstream):
		apiErr(c, http.StatusBadGateway, upstream.Error())
	case errors.As(err, &invalid):
		apiErr(c, http.StatusBadRequest, invalid.Error())
	case errors.Is(err, settingsservice.ErrMCPDisabled):
		apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
	case errors.Is(err, settingsservice.ErrMCPNotFound):
		apiErr(c, http.StatusNotFound, settingsservice.ErrMCPNotFound.Error())
	case errors.Is(err, settingsservice.ErrMCPNameTaken):
		apiErr(c, http.StatusConflict, settingsservice.ErrMCPNameTaken.Error())
	case errors.Is(err, settingsservice.ErrMCPLimit):
		apiErr(c, http.StatusBadRequest, settingsservice.ErrMCPLimit.Error())
	case errors.Is(err, settingsservice.ErrMCPCipherMissing):
		apiErr(c, http.StatusInternalServerError, settingsservice.ErrMCPCipherMissing.Error())
	case errors.Is(err, settingsservice.ErrMCPOAuthNotConfigured):
		apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPOAuthNotConfigured.Error())
	case errors.Is(err, settingsservice.ErrMCPOAuthNotAuthorized):
		apiErr(c, http.StatusConflict, settingsservice.ErrMCPOAuthNotAuthorized.Error())
	case errors.Is(err, settingsservice.ErrMCPOAuthExpired):
		apiErr(c, http.StatusUnauthorized, settingsservice.ErrMCPOAuthExpired.Error())
	default:
		slog.Error("[MCP] request failed", "err", err)
		apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
	}
}

// mcpID parses a positive int64 path parameter (invalid = 404).
func mcpID(c *gin.Context, param string, notFound string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(param), 10, 64)
	if err != nil || id <= 0 {
		apiErr(c, http.StatusNotFound, notFound)
		return 0, false
	}
	return id, true
}

// registerMCP mounts the user CRUD surface (X-Uid) and the internal M2M face
// (shared key) used by app-ts for tool discovery and chat calls.
func registerMCP(e *gin.Engine, d Deps) {
	g := e.Group("/settings/mcp/servers")

	// GET /settings/mcp/servers — masked connections + discovered tools.
	g.GET("", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		servers, err := d.MCP.ListServers(c.Request.Context(), uid)
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.MCPServers{Enabled: d.MCP.Enabled(), Servers: servers})
	})

	// POST /settings/mcp/servers — store endpoint + API key (write-only).
	g.POST("", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		var req settingsdto.MCPServerCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		server, err := d.MCP.CreateServer(c.Request.Context(), uid, settingsservice.MCPInput{
			Name:       req.Name,
			URL:        req.URL,
			AuthKind:   req.AuthKind,
			APIKey:     req.APIKey,
			AuthHeader: req.AuthHeader,
			Enabled:    req.Enabled,
		})
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusCreated, settingsdto.MCPServerEnvelope{Server: *server})
	})

	// PATCH /settings/mcp/servers/{id} — partial edit; empty api_key keeps it.
	g.PATCH("/:id", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		var req settingsdto.MCPServerUpdateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		server, err := d.MCP.UpdateServer(c.Request.Context(), uid, id, settingsservice.MCPPatch{
			Name:       req.Name,
			URL:        req.URL,
			AuthKind:   req.AuthKind,
			APIKey:     req.APIKey,
			AuthHeader: req.AuthHeader,
			Enabled:    req.Enabled,
		})
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.MCPServerEnvelope{Server: *server})
	})

	// DELETE /settings/mcp/servers/{id}.
	g.DELETE("/:id", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		if err := d.MCP.DeleteServer(c.Request.Context(), uid, id); err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.Message{Message: "MCP 连接已删除"})
	})

	// POST /settings/mcp/servers/{id}/oauth/start — discover the provider,
	// register this deployment (DCR), persist a PKCE state and return the
	// browser authorization URL.
	g.POST("/:id/oauth/start", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		start, err := d.MCP.StartOAuth(c.Request.Context(), uid, id)
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, start)
	})

	// DELETE /settings/mcp/servers/{id}/oauth — drop stored tokens.
	g.DELETE("/:id/oauth", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.MCP == nil {
			apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMCPDisabled.Error())
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		if err := d.MCP.DisconnectOAuth(c.Request.Context(), uid, id); err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.Message{Message: "已断开 OAuth 授权"})
	})

	// GET /settings/mcp/oauth/callback — PUBLIC (the provider redirects the
	// browser here without our session). state is single-use and binds uid +
	// server; the response is always a 302 back to the settings page.
	e.GET("/settings/mcp/oauth/callback", func(c *gin.Context) {
		if d.MCP == nil {
			c.String(http.StatusServiceUnavailable, "MCP 功能未启用")
			return
		}
		state := c.Query("state")
		code := c.Query("code")
		providerErr := c.Query("error")
		redirect := d.MCP.CompleteOAuth(c.Request.Context(), state, code, providerErr)
		if redirect == "" {
			c.String(http.StatusBadRequest, "OAuth 回调地址未配置")
			return
		}
		c.Redirect(http.StatusFound, redirect)
	})

	// ── internal M2M face (app-ts): decrypted connections ────────────
	internal := e.Group("/internal/settings/mcp", middleware.APIKey(d.InternalAPIKey))

	// GET /internal/settings/mcp/{uid}.
	internal.GET("/:uid", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		if d.MCP == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"detail": settingsservice.ErrMCPDisabled.Error()})
			return
		}
		servers, err := d.MCP.InternalServers(c.Request.Context(), uid)
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.InternalMCPServers{Enabled: d.MCP.Enabled(), Servers: servers})
	})

	// POST /internal/settings/mcp/{uid}/{id}/refresh — rotate the access token
	// with the stored refresh token; 401 = the user must authorize again.
	internal.POST("/:uid/:id/refresh", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		if d.MCP == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"detail": settingsservice.ErrMCPDisabled.Error()})
			return
		}
		token, err := d.MCP.RefreshOAuth(c.Request.Context(), uid, id)
		if err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, token)
	})

	// PATCH /internal/settings/mcp/{uid}/{id}/discovery — app-ts writes back
	// the tools/list result after a successful (or failed) probe.
	internal.PATCH("/:uid/:id/discovery", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		id, ok := mcpID(c, "id", settingsservice.ErrMCPNotFound.Error())
		if !ok {
			return
		}
		if d.MCP == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"detail": settingsservice.ErrMCPDisabled.Error()})
			return
		}
		var req settingsdto.MCPDiscoveryRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		if err := d.MCP.RecordDiscovery(c.Request.Context(), uid, id, req.Tools, req.LastError); err != nil {
			mcpErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.Message{Message: "ok"})
	})
}
