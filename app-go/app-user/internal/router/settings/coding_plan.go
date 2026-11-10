// /settings/coding-plans + /internal/settings/coding-plan — Coding Plan HTTP
// surface (settings domain). Identity on the user face = gateway-injected
// X-Uid (APISIX forward-auth); the M2M face is guarded by the shared apikey.
//
// Moved from the auth router: a Coding Plan is user configuration, not an
// identity concern, so the user endpoints live under /settings.
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

// codingPlanErr maps service errors to HTTP statuses without leaking internals.
func codingPlanErr(c *gin.Context, err error) {
	var invalid *settingsservice.CodingPlanValidationError
	switch {
	case errors.As(err, &invalid):
		apiErr(c, http.StatusBadRequest, invalid.Error())
	case errors.Is(err, settingsservice.ErrCodingPlanVIPOnly):
		apiErr(c, http.StatusForbidden, settingsservice.ErrCodingPlanVIPOnly.Error())
	case errors.Is(err, settingsservice.ErrMembershipUnavailable):
		apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMembershipUnavailable.Error())
	case errors.Is(err, settingsservice.ErrCodingPlanNotFound):
		apiErr(c, http.StatusNotFound, settingsservice.ErrCodingPlanNotFound.Error())
	case errors.Is(err, settingsservice.ErrCodingPlanLimit):
		apiErr(c, http.StatusBadRequest, settingsservice.ErrCodingPlanLimit.Error())
	default:
		slog.Error("[CODING_PLAN] request failed", "err", err)
		apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
	}
}

// codingPlanID parses the :id path parameter (invalid = 404, not a stack trace).
func codingPlanID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		apiErr(c, http.StatusNotFound, settingsservice.ErrCodingPlanNotFound.Error())
		return 0, false
	}
	return id, true
}

// codingPlanUnavailable renders the "membership gate not wired" 503 that the
// auth-domain handlers used to return when the service was nil.
func codingPlanUnavailable(c *gin.Context) {
	apiErr(c, http.StatusServiceUnavailable, settingsservice.ErrMembershipUnavailable.Error())
}

// registerCodingPlans mounts the user CRUD/test surface (X-Uid) and the
// internal M2M lookup (apikey).
func registerCodingPlans(e *gin.Engine, d Deps) {
	g := e.Group("/settings/coding-plans")

	// GET /settings/coding-plans — VIP/SVIP only.
	g.GET("", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		plans, err := d.CodingPlans.ListPlans(c.Request.Context(), uid)
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.CodingPlans{Plans: plans})
	})

	// POST /settings/coding-plans.
	g.POST("", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req settingsdto.CodingPlanCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		plan, err := d.CodingPlans.CreatePlan(c.Request.Context(), uid, settingsservice.CodingPlanInput{
			Provider: req.Provider,
			Protocol: req.Protocol,
			Label:    req.Label,
			BaseURL:  req.BaseURL,
			Model:    req.Model,
			APIKey:   req.APIKey,
			Enabled:  req.Enabled,
		})
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.CodingPlanEnvelope{Plan: *plan})
	})

	// PATCH /settings/coding-plans/{id}.
	g.PATCH("/:id", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, ok := codingPlanID(c)
		if !ok {
			return
		}
		var req settingsdto.CodingPlanUpdateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		plan, err := d.CodingPlans.UpdatePlan(c.Request.Context(), uid, id, settingsservice.CodingPlanPatch{
			Provider: req.Provider,
			Protocol: req.Protocol,
			Label:    req.Label,
			BaseURL:  req.BaseURL,
			Model:    req.Model,
			APIKey:   req.APIKey,
			Enabled:  req.Enabled,
		})
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.CodingPlanEnvelope{Plan: *plan})
	})

	// DELETE /settings/coding-plans/{id}.
	g.DELETE("/:id", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, ok := codingPlanID(c)
		if !ok {
			return
		}
		if err := d.CodingPlans.DeletePlan(c.Request.Context(), uid, id); err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.Message{Message: "Coding Plan 已删除"})
	})

	// GET /settings/coding-plans/{id}/models — provider model catalog for the
	// chat picker; probes only when the chat dialog asks, never on save.
	g.GET("/:id/models", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, ok := codingPlanID(c)
		if !ok {
			return
		}
		models, err := d.CodingPlans.ListModels(c.Request.Context(), uid, id)
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, models)
	})

	// POST /settings/coding-plans/{id}/test (probe only, no writes).
	g.POST("/:id/test", func(c *gin.Context) {
		if d.CodingPlans == nil {
			codingPlanUnavailable(c)
			return
		}
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, ok := codingPlanID(c)
		if !ok {
			return
		}
		result, err := d.CodingPlans.Test(c.Request.Context(), uid, id)
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	})

	// GET /internal/settings/coding-plan/{uid} — oldest enabled plan with the
	// decrypted key for the in-site code agent (M2M apikey). 404 = no usable
	// plan; 403 = not VIP/SVIP; 503 = membership service unavailable.
	internal := e.Group("/internal/settings/coding-plan", middleware.APIKey(d.InternalAPIKey))
	internal.GET("/:uid", func(c *gin.Context) {
		uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
		if err != nil || uid <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		if d.CodingPlans == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"detail": settingsservice.ErrMembershipUnavailable.Error()})
			return
		}
		plan, err := d.CodingPlans.InternalGet(c.Request.Context(), uid)
		if err != nil {
			codingPlanErr(c, err)
			return
		}
		c.JSON(http.StatusOK, settingsdto.InternalCodingPlanEnvelope{
			Plan: settingsdto.InternalCodingPlan{
				ID:       plan.ID,
				Provider: plan.Provider,
				Protocol: plan.Protocol,
				Label:    plan.Label,
				BaseURL:  plan.BaseURL,
				Model:    plan.Model,
				APIKey:   plan.APIKey,
			},
		})
	})
}
