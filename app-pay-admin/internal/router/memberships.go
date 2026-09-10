// Package router: membership + entitlement event endpoints
// (pay_membership / pay_membership_event).
package router

import (
	"net/http"
	"strconv"
	"time"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

// apiListMemberships GET /api/memberships?uid=
// With uid: exact lookup -> {"membership": {...}|null}. Without: one page.
func (r *Router) apiListMemberships(c *gin.Context) {
	if v := c.Query("uid"); v != "" {
		uid, err := strconv.ParseInt(v, 10, 64)
		if err != nil || uid < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		m, err := repo.GetMembershipByUID(uid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
			return
		}
		if m == nil {
			c.JSON(http.StatusOK, gin.H{"membership": nil})
			return
		}
		c.JSON(http.StatusOK, gin.H{"membership": membershipView(m)})
		return
	}

	limit, offset := pagination(c, 50, 200)
	ms, total, err := repo.ListMemberships(limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(ms))
	for i := range ms {
		items = append(items, membershipView(&ms[i]))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "items": items})
}

// apiMemberEvents GET /api/memberships/:uid/events — one member's entitlement
// audit stream (ACTIVATE / RENEW / ADMIN_GRANT), newest first.
func (r *Router) apiMemberEvents(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
	if err != nil || uid < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
		return
	}
	limit, offset := pagination(c, 50, 200)
	evs, total, err := repo.ListEventsByUID(uid, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(evs))
	for i := range evs {
		items = append(items, eventView(&evs[i]))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "items": items})
}

// apiListEvents GET /api/events?uid=&type= — the global entitlement event
// stream (serves the ADMIN_GRANT audit trail review).
func (r *Router) apiListEvents(c *gin.Context) {
	limit, offset := pagination(c, 50, 200)
	f := repo.EventFilter{Type: c.Query("type"), Limit: limit, Offset: offset}
	if v := c.Query("uid"); v != "" {
		uid, err := strconv.ParseInt(v, 10, 64)
		if err != nil || uid < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		f.UID, f.UIDSet = uid, true
	}
	evs, total, err := repo.ListEvents(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(evs))
	for i := range evs {
		items = append(items, eventView(&evs[i]))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "items": items})
}

// membershipView adds the lazy-expiry `active` flag (expire_at > now), the
// same semantics as app-pay's isActive.
func membershipView(m *model.PayMembership) gin.H {
	return gin.H{
		"uid":           m.UID,
		"tier":          m.Tier,
		"active":        m.ExpireAt.After(time.Now()),
		"expire_at":     m.ExpireAt.Format(time.RFC3339),
		"auto_renew":    m.AutoRenew,
		"last_order_no": m.LastOrderNo,
		"created_at":    m.CreatedAt.Format(time.RFC3339),
		"updated_at":    m.UpdatedAt.Format(time.RFC3339),
	}
}

func eventView(e *model.PayMembershipEvent) gin.H {
	return gin.H{
		"id":            e.ID,
		"uid":           e.UID,
		"type":          e.Type,
		"order_no":      e.OrderNo,
		"days":          e.Days,
		"expire_before": e.ExpireBefore.Format(time.RFC3339),
		"expire_after":  e.ExpireAfter.Format(time.RFC3339),
		"reason":        e.Reason,
		"created_at":    e.CreatedAt.Format(time.RFC3339),
	}
}
