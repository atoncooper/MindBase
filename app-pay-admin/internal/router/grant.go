// Package router: POST /api/grants — 运营补偿开通/延期 (admin only).
//
// Request mirrors app-pay's POST /internal/pay/grant contract:
// {"uid": >0, "duration_days": >=1, "reason": required}. The operator identity
// comes from the console session and rides into pay_membership_event.reason as
// "[<username>] ..." (the Java-owned table has no operator column).
package router

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// maxEventReason is pay_membership_event.reason's column width (VARCHAR(200)).
const maxEventReason = 200

// maxGrantDays is a sanity cap (10 years) against fat-finger values; app-pay
// itself only enforces days >= 1.
const maxGrantDays = 3650

func (r *Router) apiGrant(c *gin.Context) {
	var req struct {
		UID          int64  `json:"uid" binding:"required,gt=0"`
		DurationDays int    `json:"duration_days" binding:"required,gt=0,lte=3650"`
		Reason       string `json:"reason" binding:"required"`
		Tier         string `json:"tier"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid request: " + err.Error()})
		return
	}
	if req.DurationDays > maxGrantDays {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "duration_days too large (max 3650)"})
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "reason required"})
		return
	}
	operator := operatorOf(c)
	if operator == "" {
		// Defensive: the auth middleware always sets an identity.
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "operator identity missing"})
		return
	}
	// Keep the audit reason within the Java column width after the operator
	// prefix is prepended.
	finalReason := "[" + operator + "] " + reason
	if utf8.RuneCountInString(finalReason) > maxEventReason {
		c.JSON(http.StatusBadRequest, gin.H{
			"detail": "reason too long: operator prefix + reason must fit 200 chars",
		})
		return
	}

	tier := strings.ToUpper(strings.TrimSpace(req.Tier))
	if tier != "" && tier != "VIP" && tier != "SVIP" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "tier must be VIP or SVIP"})
		return
	}
	res, err := r.grants.Grant(c.Request.Context(), operator, req.UID, req.DurationDays, reason, tier)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "grant failed: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"uid":           req.UID,
		"tier":          res.Membership.Tier,
		"days":          req.DurationDays,
		"expire_before": res.Before.Format(time.RFC3339),
		"expire_after":  res.After.Format(time.RFC3339),
		"created":       res.Created,
		"active":        res.After.After(time.Now()),
	})
}
