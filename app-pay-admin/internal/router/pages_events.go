// Package router: global entitlement event stream page (audit trail review).
package router

import (
	"log/slog"
	"net/http"
	"strconv"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

func (r *Router) pageEvents(c *gin.Context) {
	b := newBase(c, "events", "事件流水", "权益变更审计流：开通 / 续费 / 运营补偿（对账与客诉取证）")

	uidRaw := c.Query("uid")
	typ := c.Query("type")
	f := repo.EventFilter{Type: typ, Limit: pageSize, Offset: (queryPage(c) - 1) * pageSize}
	if uidRaw != "" {
		uid, err := strconv.ParseInt(uidRaw, 10, 64)
		if err != nil || uid < 0 {
			b.Flash = &flashData{Kind: "warn", Msg: "uid 必须为非负整数"}
			uidRaw = ""
		} else {
			f.UID, f.UIDSet = uid, true
		}
	}

	page := queryPage(c)
	evs, total, err := repo.ListEvents(f)
	if err != nil {
		slog.Error("[PAGE] list events failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]eventRow, 0, len(evs))
	for i := range evs {
		items = append(items, shapeEvent(&evs[i]))
	}
	renderPage(c.Writer, "events", struct {
		BaseData
		UID         string
		TypeOptions []selectOpt
		Items       []eventRow
		pageNav
	}{
		BaseData:    b,
		UID:         uidRaw,
		TypeOptions: eventTypeOptions(typ),
		Items:       items,
		pageNav:     buildPageNav(c, "/events", urlValues(map[string]string{"uid": uidRaw, "type": typ}), page, total),
	})
}
