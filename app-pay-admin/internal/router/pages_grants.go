// Package router: membership grant page + form submit (POST-redirect-GET).
package router

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

type grantRow struct {
	CreatedAt    string
	UID          int64
	Days         int
	ExpireBefore string
	ExpireAfter  string
	Reason       string
}

func (r *Router) pageGrants(c *gin.Context) {
	b := newBase(c, "grants", "补偿开通", "会员补偿开通 / 延期（资金写操作：pay_membership_event + 自有 JSONL 双审计留痕）")

	evs, _, err := repo.ListEvents(repo.EventFilter{Type: "ADMIN_GRANT", Limit: 20, Offset: 0})
	if err != nil {
		slog.Error("[PAGE] list grants failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	recent := make([]grantRow, 0, len(evs))
	for i := range evs {
		recent = append(recent, grantRow{
			CreatedAt:    fmtTime(evs[i].CreatedAt),
			UID:          evs[i].UID,
			Days:         evs[i].Days,
			ExpireBefore: fmtTime(evs[i].ExpireBefore),
			ExpireAfter:  fmtTime(evs[i].ExpireAfter),
			Reason:       fmtStrPtr(evs[i].Reason),
		})
	}
	renderPage(c.Writer, "grants", struct {
		BaseData
		Recent []grantRow
	}{
		BaseData: b,
		Recent:   recent,
	})
}

func (r *Router) handleGrantForm(c *gin.Context) {
	s, ok := currentUser(c)
	if !ok || s.Role != repo.RoleAdmin {
		redirectFlash(c, "/grants", "err", "需要 admin 角色")
		return
	}
	uid, err := strconv.ParseInt(strings.TrimSpace(c.PostForm("uid")), 10, 64)
	if err != nil || uid < 1 {
		redirectFlash(c, "/grants", "err", "uid 不合法（需为正整数）")
		return
	}
	days, err := strconv.Atoi(strings.TrimSpace(c.PostForm("duration_days")))
	if err != nil || days < 1 || days > maxGrantDays {
		redirectFlash(c, "/grants", "err", "天数需在 1–%d 之间", maxGrantDays)
		return
	}
	reason := strings.TrimSpace(c.PostForm("reason"))
	tier := strings.ToUpper(strings.TrimSpace(c.PostForm("tier")))
	if tier != "" && tier != "VIP" && tier != "SVIP" {
		redirectFlash(c, "/grants", "err", "tier 必须为 VIP 或 SVIP")
		return
	}
	if reason == "" {
		redirectFlash(c, "/grants", "err", "原因必填（审计留痕）")
		return
	}
	if utf8.RuneCountInString("["+s.Username+"] "+reason) > maxEventReason {
		redirectFlash(c, "/grants", "err", "原因过长：操作人前缀 + 原因需 ≤%d 字符", maxEventReason)
		return
	}

	res, err := r.grants.Grant(c.Request.Context(), s.Username, uid, days, reason, tier)
	if err != nil {
		slog.Error("[GRANT] form grant failed", "err", err, "operator", s.Username, "uid", uid)
		redirectFlash(c, "/grants", "err", "开通失败：%v", err)
		return
	}
	redirectFlash(c, "/grants", "ok", "已为 uid %d 开通 %d 天：%s → %s",
		uid, days, fmtTime(res.Before), fmtTime(res.After))
}
