// Package router: shared plumbing for SSR pages — base data, flash messages,
// page navigation, and display shaping helpers (money/time/status maps).
package router

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

// ── base data / flash ───────────────────────────────────────────────

type userData struct {
	Username string
	IsAdmin  bool
}

type flashData struct {
	Kind string // ok / err / warn
	Msg  string
}

// BaseData is embedded into every page's data struct; templates access its
// fields directly via promotion.
type BaseData struct {
	Version   string
	User      userData
	Active    string // active tab id (orders/memberships/...)
	PageTitle string
	PageDesc  string
	Flash     *flashData
}

// newBase builds the shell data from the request: current user, active tab,
// title, and any ?ok=/?err= flash message left by a redirect.
func newBase(c *gin.Context, active, title, desc string) BaseData {
	b := BaseData{Version: webuiVersion, Active: active, PageTitle: title, PageDesc: desc}
	if s, ok := currentUser(c); ok {
		b.User = userData{Username: s.Username, IsAdmin: s.Role == repo.RoleAdmin}
	}
	if msg := c.Query("ok"); msg != "" {
		b.Flash = &flashData{Kind: "ok", Msg: msg}
	} else if msg := c.Query("err"); msg != "" {
		b.Flash = &flashData{Kind: "err", Msg: msg}
	}
	return b
}

// redirectFlash bounces back to path carrying an ?ok=/?err= flash message
// (POST-redirect-GET; messages are url-encoded and auto-escaped on render).
func redirectFlash(c *gin.Context, path, kind, format string, args ...any) {
	v := url.Values{}
	v.Set(kind, fmt.Sprintf(format, args...))
	sep := "?"
	if u, err := url.Parse(path); err == nil && u.RawQuery != "" {
		sep = "&"
	}
	c.Redirect(http.StatusSeeOther, path+sep+v.Encode())
}

// ── page navigation ─────────────────────────────────────────────────

const pageSize = 20

type pageNav struct {
	Page     int
	PageSize int
	Total    int64
	HasPrev  bool
	HasNext  bool
	PrevURL  string
	NextURL  string
}

// queryPage reads the 1-based page number (default 1).
func queryPage(c *gin.Context) int {
	if p, err := strconv.Atoi(c.Query("page")); err == nil && p >= 1 {
		return p
	}
	return 1
}

// buildPageNav computes prev/next links carrying the current query (filters)
// forward, so pagination never drops the active filters.
func buildPageNav(c *gin.Context, path string, q url.Values, page int, total int64) pageNav {
	nav := pageNav{Page: page, PageSize: pageSize, Total: total}
	withPage := func(p int) string {
		v := url.Values{}
		for k, vs := range q {
			for _, vv := range vs {
				v.Add(k, vv)
			}
		}
		if p > 1 {
			v.Set("page", strconv.Itoa(p))
		}
		return path + "?" + v.Encode()
	}
	if page > 1 {
		nav.HasPrev = true
		nav.PrevURL = withPage(page - 1)
	}
	if int64(page*pageSize) < total {
		nav.HasNext = true
		nav.NextURL = withPage(page + 1)
	}
	return nav
}

// urlValues converts a filter map into url.Values (skipping empty values).
func urlValues(m map[string]string) url.Values {
	v := url.Values{}
	for k, val := range m {
		if val != "" {
			v.Set(k, val)
		}
	}
	return v
}

// ── display shaping ─────────────────────────────────────────────────

// fmtMoney renders long cents as ¥x.yy — integer math only, never floats.
func fmtMoney(cents int64) string {
	neg := ""
	if cents < 0 {
		neg = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s¥%d.%02d", neg, cents/100, cents%100)
}

// fmtTime renders Asia/Shanghai wall-clock (time.Local is pinned in main).
func fmtTime(t time.Time) string { return t.Format("2006-01-02 15:04:05") }

func fmtTimePtr(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return fmtTime(*t)
}

func fmtStrPtr(p *string) string {
	if p == nil || *p == "" {
		return "-"
	}
	return *p
}

// ── status / type maps (order state machine, callbacks, events) ─────

var orderStatusText = map[string]string{
	"CREATED": "已创建", "PAID": "已支付", "DELIVERED": "已交付",
	"CLOSED": "已关闭", "REFUNDING": "退款中", "REFUNDED": "已退款",
}

var orderStatusClass = map[string]string{
	"CREATED": "gray", "PAID": "blue", "DELIVERED": "green",
	"CLOSED": "gray", "REFUNDING": "orange", "REFUNDED": "purple",
}

var eventTypeText = map[string]string{
	"ACTIVATE": "开通", "RENEW": "续费", "ADMIN_GRANT": "补偿开通", "REFUND_REVOKE": "退款扣回",
}

var eventTypeClass = map[string]string{
	"ACTIVATE": "green", "RENEW": "blue", "ADMIN_GRANT": "orange", "REFUND_REVOKE": "red",
}

var signatureClass = map[string]string{"VALID": "green", "SKIPPED": "gray", "INVALID": "red"}

var handleResultClass = map[string]string{
	"ACCEPTED": "green", "ACCEPTED_DUPLICATE": "green",
	"IGNORED": "gray", "ORDER_NOT_FOUND": "gray", "ERROR": "red",
}

// selectOpt feeds the filter dropdowns (value + label + selected flag).
type selectOpt struct {
	V   string
	T   string
	Sel bool
}

func statusOptions(current string) []selectOpt {
	opts := make([]selectOpt, 0, len(orderStatusText))
	for _, s := range []string{"CREATED", "PAID", "DELIVERED", "CLOSED", "REFUNDING", "REFUNDED"} {
		opts = append(opts, selectOpt{V: s, T: orderStatusText[s], Sel: s == current})
	}
	return opts
}

var payChannels = []string{"MOCK", "ALIPAY", "WECHAT_PAY"}

func channelOptions(current string) []selectOpt {
	opts := make([]selectOpt, 0, len(payChannels))
	for _, ch := range payChannels {
		opts = append(opts, selectOpt{V: ch, T: ch, Sel: ch == current})
	}
	return opts
}

func eventTypeOptions(current string) []selectOpt {
	opts := make([]selectOpt, 0, len(eventTypeText))
	for _, t := range []string{"ACTIVATE", "RENEW", "ADMIN_GRANT", "REFUND_REVOKE"} {
		opts = append(opts, selectOpt{V: t, T: eventTypeText[t], Sel: t == current})
	}
	return opts
}
