// Package router: console pages for API-key management (admin only).
//
// List + revoke follow the console PRG+flash pattern. Creation uses a
// one-time reveal: POST mints the key, stores the plaintext in an in-memory
// single-read store, sets a short-lived reveal cookie and redirects; the
// result page consumes both exactly once. The plaintext is therefore never
// in a URL (access logs) and never rendered twice.
package router

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-task/internal/repo"

	"github.com/gin-gonic/gin"
)

const apiKeyRevealCookie = "apptask_key_reveal"

// maxActiveAPIKeys caps how many ACTIVE keys may exist — prevents unbounded
// credential sprawl from repeated console submissions.
const maxActiveAPIKeys = 50

// allAPIKeyScopes is the full scope set; bootstrap keys get all of them.
var allAPIKeyScopes = []string{scopeTasks, scopeScripts, scopeInternal}

type apiKeyRow struct {
	KeyID, Name, KeyPrefix, Status, StatusCli, CreatedBy string
	Scopes                                               []string
	RatePerMin                                           string
	LastUsedAt, ExpiresAt, CreatedAt                     string
	Active                                               bool
}

func (r *Router) pageAPIKeys(c *gin.Context) {
	if _, ok := requireAdminPage(c); !ok {
		return
	}
	keys, err := repo.ListAPIKeys()
	if err != nil {
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	rows := make([]apiKeyRow, 0, len(keys))
	for _, k := range keys {
		st, sc := statusOf(k.Status)
		scopes := []string{}
		if k.Scopes == "" {
			scopes = append(scopes, "all")
		} else {
			scopes = strings.Split(k.Scopes, ",")
		}
		rate := "不限"
		if k.RatePerMin > 0 {
			rate = strconv.Itoa(k.RatePerMin) + "/分"
		}
		rows = append(rows, apiKeyRow{
			KeyID:      k.KeyID,
			Name:       k.Name,
			KeyPrefix:  k.KeyPrefix,
			Scopes:     scopes,
			RatePerMin: rate,
			Status:     st,
			StatusCli:  sc,
			CreatedBy:  k.CreatedBy,
			LastUsedAt: fmtTimePtr(k.LastUsedAt),
			ExpiresAt:  fmtTimePtr(k.ExpiresAt),
			CreatedAt:  fmtTime(k.CreatedAt),
			Active:     k.Status == repo.APIKeyStatusActive,
		})
	}
	activeCount, _ := repo.CountActiveAPIKeys()
	renderPage(c.Writer, "apikeys", struct {
		BaseData
		Items       []apiKeyRow
		ActiveCount int64
		MaxActive   int
	}{
		BaseData:    newBase(c, "apikeys", "API 密钥", "service 面（/tasks/*、/scripts*、/internal/*）的调用凭证；明文仅在生成时显示一次"),
		Items:       rows,
		ActiveCount: activeCount,
		MaxActive:   maxActiveAPIKeys,
	})
}

// handleAPIKeyCreate mints a new key. The plaintext is rendered exactly once
// on the reveal page (consumed via one-time token + cookie).
func (r *Router) handleAPIKeyCreate(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" || len(name) > 64 {
		redirectFlash(c, "/console/apikeys", "err", "名称需 1–64 字符")
		return
	}
	if exists, err := repo.APIKeyNameExists(name); err != nil {
		redirectFlash(c, "/console/apikeys", "err", "查询失败：%v", err)
		return
	} else if exists {
		redirectFlash(c, "/console/apikeys", "err", "名称已存在：%s（名称全局唯一，含已吊销密钥）", name)
		return
	}
	expiresDays, _ := strconv.Atoi(strings.TrimSpace(c.PostForm("expires_days")))
	if expiresDays < 0 || expiresDays > 3650 {
		redirectFlash(c, "/console/apikeys", "err", "有效期需 0–3650 天（0 = 永不过期）")
		return
	}
	ratePerMin, _ := strconv.Atoi(strings.TrimSpace(c.PostForm("rate_per_min")))
	if ratePerMin < 0 || ratePerMin > 600 {
		redirectFlash(c, "/console/apikeys", "err", "限流需 0–600 次/分钟（0 = 不限）")
		return
	}
	scopes := c.PostFormArray("scopes")
	if len(scopes) == 0 {
		redirectFlash(c, "/console/apikeys", "err", "至少选择一个权限范围")
		return
	}
	for _, sc := range scopes {
		if sc != scopeTasks && sc != scopeScripts && sc != scopeInternal {
			redirectFlash(c, "/console/apikeys", "err", "未知权限范围：%s", sc)
			return
		}
	}
	if active, _ := repo.CountActiveAPIKeys(); active >= maxActiveAPIKeys {
		redirectFlash(c, "/console/apikeys", "err", "活跃密钥已达上限（%d 把），请先吊销不用的密钥", maxActiveAPIKeys)
		return
	}

	plaintext, row, err := generateAPIKey()
	if err != nil {
		redirectFlash(c, "/console/apikeys", "err", "生成失败：%v", err)
		return
	}
	row.Name = name
	row.CreatedBy = s.Username
	row.Scopes = strings.Join(scopes, ",")
	row.RatePerMin = ratePerMin
	if expiresDays > 0 {
		exp := time.Now().AddDate(0, 0, expiresDays)
		row.ExpiresAt = &exp
	}
	if err := repo.CreateAPIKey(row); err != nil {
		redirectFlash(c, "/console/apikeys", "err", "保存失败：%v", err)
		return
	}

	token := r.keys.putReveal(plaintext)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     apiKeyRevealCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(apiKeyRevealTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https",
	})
	c.Redirect(http.StatusSeeOther, "/console/apikeys/revealed")
}

// pageAPIKeyRevealed consumes the one-time reveal token and shows the
// plaintext key exactly once.
func (r *Router) pageAPIKeyRevealed(c *gin.Context) {
	if _, ok := requireAdminPage(c); !ok {
		return
	}
	token, err := c.Cookie(apiKeyRevealCookie)
	plaintext, ok := "", false
	if err == nil && token != "" {
		plaintext, ok = r.keys.takeReveal(token)
	}
	// The cookie is single-use either way.
	http.SetCookie(c.Writer, &http.Cookie{
		Name: apiKeyRevealCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
	if !ok {
		redirectFlash(c, "/console/apikeys", "err", "密钥展示已失效（只能查看一次），请重新生成")
		return
	}
	renderPage(c.Writer, "apikey_created", struct {
		BaseData
		Plaintext string
		Prefix    string
	}{
		BaseData:  newBase(c, "apikeys", "密钥已生成", "请立即复制保存——关闭本页后明文不可再查看"),
		Plaintext: plaintext,
		Prefix:    plaintext[:min(12, len(plaintext))] + "…",
	})
}

// handleAPIKeyRevoke flips an active key to revoked (two-step confirm in UI).
func (r *Router) handleAPIKeyRevoke(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	keyID := c.Param("key_id")
	row, err := repo.GetAPIKeyByID(keyID)
	if err != nil || row == nil {
		redirectFlash(c, "/console/apikeys", "err", "密钥不存在")
		return
	}
	revoked, err := repo.RevokeAPIKey(keyID)
	if err != nil {
		redirectFlash(c, "/console/apikeys", "err", "吊销失败：%v", err)
		return
	}
	if !revoked {
		redirectFlash(c, "/console/apikeys", "err", "密钥已处于吊销状态：%s", row.Name)
		return
	}
	slog.Info("[APIKEY] revoked", "operator", s.Username, "key", row.Name, "key_id", keyID)
	redirectFlash(c, "/console/apikeys", "ok", "已吊销：%s", row.Name)
}
