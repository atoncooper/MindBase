// Package router: SKU catalog page (read-only in phase 1).
package router

import (
	"log/slog"
	"net/http"
	"time"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

type productRow struct {
	Code         string
	Title        string
	DurationDays int
	Price        string
	Active       bool
	Sort         int
	UpdatedAt    string
}

func shapeProduct(p *model.PayProduct) productRow {
	return productRow{
		Code:         p.Code,
		Title:        p.Title,
		DurationDays: p.DurationDays,
		Price:        fmtMoney(p.PriceCents),
		Active:       p.Status == "ACTIVE",
		Sort:         p.Sort,
		UpdatedAt:    fmtTime(p.UpdatedAt),
	}
}

func (r *Router) pageProducts(c *gin.Context) {
	ps, err := repo.ListProducts()
	if err != nil {
		slog.Error("[PAGE] list products failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	_ = time.Now
	items := make([]productRow, 0, len(ps))
	for i := range ps {
		items = append(items, shapeProduct(&ps[i]))
	}
	renderPage(c.Writer, "products", struct {
		BaseData
		Items []productRow
	}{
		BaseData: newBase(c, "products", "SKU 商品", "在售商品目录（只读；改价走 app-pay 运营改库流程）"),
		Items:    items,
	})
}
