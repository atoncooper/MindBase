// Package router: SKU catalog (pay_product, read-only in phase 1 — price /
// status changes remain an app-pay-side operational task).
package router

import (
	"net/http"
	"time"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

func (r *Router) apiListProducts(c *gin.Context) {
	ps, err := repo.ListProducts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(ps))
	for i := range ps {
		items = append(items, productView(&ps[i]))
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func productView(p *model.PayProduct) gin.H {
	return gin.H{
		"code":          p.Code,
		"title":         p.Title,
		"duration_days": p.DurationDays,
		"price_cents":   p.PriceCents,
		"status":        p.Status,
		"sort":          p.Sort,
		"created_at":    p.CreatedAt.Format(time.RFC3339),
		"updated_at":    p.UpdatedAt.Format(time.RFC3339),
	}
}
