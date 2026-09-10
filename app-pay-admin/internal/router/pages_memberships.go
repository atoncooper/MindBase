// Package router: membership list + per-member entitlement event pages.
package router

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

type memberRow struct {
	UID         int64
	Tier        string
	Active      bool
	AutoRenew   bool
	ExpireAt    string
	LastOrderNo string
	UpdatedAt   string
}

func shapeMember(m *model.PayMembership) memberRow {
	return memberRow{
		UID:         m.UID,
		Tier:        m.Tier,
		Active:      m.ExpireAt.After(time.Now()),
		AutoRenew:   m.AutoRenew,
		ExpireAt:    fmtTime(m.ExpireAt),
		LastOrderNo: fmtStrPtr(m.LastOrderNo),
		UpdatedAt:   fmtTime(m.UpdatedAt),
	}
}

func (r *Router) pageMemberships(c *gin.Context) {
	b := newBase(c, "memberships", "会员", "会员实例与到期状态（懒过期：expire_at > now 即生效）")

	// uid 精确查询卡片
	uidRaw := c.Query("uid")
	var matched *memberRow
	if uidRaw != "" {
		uid, err := strconv.ParseInt(uidRaw, 10, 64)
		if err != nil || uid < 0 {
			b.Flash = &flashData{Kind: "warn", Msg: "uid 必须为非负整数"}
		} else {
			m, err := repo.GetMembershipByUID(uid)
			if err != nil {
				slog.Error("[PAGE] get membership failed", "err", err)
				http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
				return
			}
			if m != nil {
				row := shapeMember(m)
				matched = &row
			}
		}
	}

	page := queryPage(c)
	ms, total, err := repo.ListMemberships(pageSize, (page-1)*pageSize)
	if err != nil {
		slog.Error("[PAGE] list memberships failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]memberRow, 0, len(ms))
	for i := range ms {
		items = append(items, shapeMember(&ms[i]))
	}
	renderPage(c.Writer, "memberships", struct {
		BaseData
		UID      string
		Searched bool
		Matched  *memberRow
		Items    []memberRow
		pageNav
	}{
		BaseData: b,
		UID:      uidRaw,
		Searched: uidRaw != "",
		Matched:  matched,
		Items:    items,
		pageNav:  buildPageNav(c, "/memberships", urlValues(map[string]string{"uid": uidRaw}), page, total),
	})
}

type eventRow struct {
	CreatedAt    string
	UID          int64
	TypeText     string
	TypeClass    string
	Days         int
	ExpireBefore string
	ExpireAfter  string
	OrderNo      string
	Reason       string
}

func shapeEvent(e *model.PayMembershipEvent) eventRow {
	return eventRow{
		CreatedAt:    fmtTime(e.CreatedAt),
		UID:          e.UID,
		TypeText:     eventTypeText[e.Type],
		TypeClass:    eventTypeClass[e.Type],
		Days:         e.Days,
		ExpireBefore: fmtTime(e.ExpireBefore),
		ExpireAfter:  fmtTime(e.ExpireAfter),
		OrderNo:      fmtStrPtr(e.OrderNo),
		Reason:       fmtStrPtr(e.Reason),
	}
}

func (r *Router) pageMemberEvents(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("uid"), 10, 64)
	if err != nil || uid < 0 {
		render404(c, "uid 不合法")
		return
	}
	page := queryPage(c)
	evs, total, err := repo.ListEventsByUID(uid, pageSize, (page-1)*pageSize)
	if err != nil {
		slog.Error("[PAGE] list member events failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]eventRow, 0, len(evs))
	for i := range evs {
		items = append(items, shapeEvent(&evs[i]))
	}
	renderPage(c.Writer, "member_events", struct {
		BaseData
		Items []eventRow
		pageNav
	}{
		BaseData: newBase(c, "memberships", fmt.Sprintf("会员权益事件 · uid %d", uid), ""),
		Items:    items,
		pageNav:  buildPageNav(c, fmt.Sprintf("/memberships/%d/events", uid), url.Values{}, page, total),
	})
}
