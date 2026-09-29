// Package router: console pages for the central secret store (admin only).
//
// Secrets are write-only from the console: names/descriptions render, but
// plaintext values are never displayed after creation (not even to admins).
// Scripts read them at runtime via ctx.secret(name); every fetched value is
// masked in ctx.log output and task/script_run error text.
package router

import (
	"net/http"
	"regexp"
	"strings"

	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/internal/security"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	maxSecretCount = 100
	maxSecretBytes = 8 << 10
)

var secretNameRE = regexp.MustCompile(`^[a-z][a-z0-9_]{1,62}[a-z0-9]$`)

type secretRow struct {
	SecretID, Name, Description, CreatedBy, UpdatedBy string
	CreatedAt, UpdatedAt                              string
}

// secretCipher resolves the cipher lazily from config; nil when the
// encryption key is not configured (feature disabled).
func (r *Router) secretCipher() *security.Cipher {
	if r.cfg.Security.SecretEncKey == "" {
		return nil
	}
	c, err := security.NewCipher(r.cfg.Security.SecretEncKey)
	if err != nil {
		return nil
	}
	return c
}

func (r *Router) pageSecrets(c *gin.Context) {
	if _, ok := requireAdminPage(c); !ok {
		return
	}
	rows := make([]secretRow, 0)
	secrets, err := repo.ListSecrets()
	if err != nil {
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	for _, s := range secrets {
		rows = append(rows, secretRow{
			SecretID:    s.SecretID,
			Name:        s.Name,
			Description: s.Description,
			CreatedBy:   s.CreatedBy,
			UpdatedBy:   s.UpdatedBy,
			CreatedAt:   fmtTime(s.CreatedAt),
			UpdatedAt:   fmtTime(s.UpdatedAt),
		})
	}
	renderPage(c.Writer, "secrets", struct {
		BaseData
		Items    []secretRow
		MaxCount int
		Enabled  bool
	}{
		BaseData: newBase(c, "secrets", "密钥管理", "第三方服务凭据的中心密钥库；Lua 脚本经 ctx.secret('name') 读取，明文永不回显"),
		Items:    rows,
		MaxCount: maxSecretCount,
		Enabled:  r.secretCipher() != nil,
	})
}

// handleSecretCreate stores a new secret (name + description + value).
func (r *Router) handleSecretCreate(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	cipher := r.secretCipher()
	if cipher == nil {
		redirectFlash(c, "/console/secrets", "err", "密钥库未启用：缺少 SECURITY__API_KEY_ENCRYPTION_KEY")
		return
	}
	name := strings.TrimSpace(c.PostForm("name"))
	description := strings.TrimSpace(c.PostForm("description"))
	value := c.PostForm("value")
	if !secretNameRE.MatchString(name) {
		redirectFlash(c, "/console/secrets", "err", "名称需为小写字母开头的 [a-z0-9_]（2–64 位）")
		return
	}
	if len(description) > 255 {
		redirectFlash(c, "/console/secrets", "err", "描述过长（≤255 字符）")
		return
	}
	if value == "" || len(value) > maxSecretBytes {
		redirectFlash(c, "/console/secrets", "err", "密钥值必填且 ≤8KB")
		return
	}
	if exists, err := repo.GetSecretByName(name); err != nil {
		redirectFlash(c, "/console/secrets", "err", "查询失败：%v", err)
		return
	} else if exists != nil {
		redirectFlash(c, "/console/secrets", "err", "同名密钥已存在：%s（请用「更新」）", name)
		return
	}
	if count, _ := repo.CountSecrets(); count >= maxSecretCount {
		redirectFlash(c, "/console/secrets", "err", "密钥数量已达上限（%d）", maxSecretCount)
		return
	}
	enc, err := cipher.Encrypt(value)
	if err != nil {
		redirectFlash(c, "/console/secrets", "err", "加密失败：%v", err)
		return
	}
	if err := repo.CreateSecret(&model.Secret{
		SecretID:    uuid.NewString(),
		Name:        name,
		Description: description,
		ValueEnc:    enc,
		CreatedBy:   s.Username,
		UpdatedBy:   s.Username,
	}); err != nil {
		if err == repo.ErrSecretExists {
			redirectFlash(c, "/console/secrets", "err", "同名密钥已存在：%s", name)
			return
		}
		redirectFlash(c, "/console/secrets", "err", "保存失败：%v", err)
		return
	}
	redirectFlash(c, "/console/secrets", "ok", "密钥已保存：%s（明文不可再查看）", name)
}

// handleSecretUpdate overwrites description and optionally the value. The
// target is addressed by secret_id (row identity), never by name.
func (r *Router) handleSecretUpdate(c *gin.Context) {
	s, ok := requireAdminPage(c)
	if !ok {
		return
	}
	cipher := r.secretCipher()
	if cipher == nil {
		redirectFlash(c, "/console/secrets", "err", "密钥库未启用：缺少 SECURITY__API_KEY_ENCRYPTION_KEY")
		return
	}
	secretID := strings.TrimSpace(c.PostForm("secret_id"))
	description := strings.TrimSpace(c.PostForm("description"))
	value := c.PostForm("value")
	if secretID == "" {
		redirectFlash(c, "/console/secrets", "err", "密钥标识缺失")
		return
	}
	row, err := repo.GetSecretBySecretID(secretID)
	if err != nil {
		redirectFlash(c, "/console/secrets", "err", "查询失败：%v", err)
		return
	}
	if row == nil {
		redirectFlash(c, "/console/secrets", "err", "密钥不存在")
		return
	}
	var enc string
	if value != "" {
		if len(value) > maxSecretBytes {
			redirectFlash(c, "/console/secrets", "err", "密钥值 ≤8KB")
			return
		}
		e, err := cipher.Encrypt(value)
		if err != nil {
			redirectFlash(c, "/console/secrets", "err", "加密失败：%v", err)
			return
		}
		enc = e
	}
	if err := repo.UpdateSecret(secretID, description, enc, s.Username); err != nil {
		if err == repo.ErrSecretNotFound {
			redirectFlash(c, "/console/secrets", "err", "密钥不存在：%s", row.Name)
			return
		}
		redirectFlash(c, "/console/secrets", "err", "更新失败：%v", err)
		return
	}
	redirectFlash(c, "/console/secrets", "ok", "密钥已更新：%s", row.Name)
}

// handleSecretDelete removes a secret (confirm step in UI).
func (r *Router) handleSecretDelete(c *gin.Context) {
	if _, ok := requireAdminPage(c); !ok {
		return
	}
	row, err := repo.GetSecretBySecretID(c.Param("secret_id"))
	if err != nil {
		redirectFlash(c, "/console/secrets", "err", "查询失败：%v", err)
		return
	}
	if row == nil {
		redirectFlash(c, "/console/secrets", "err", "密钥不存在")
		return
	}
	deleted, err := repo.DeleteSecret(row.Name)
	if err != nil {
		redirectFlash(c, "/console/secrets", "err", "删除失败：%v", err)
		return
	}
	if !deleted {
		redirectFlash(c, "/console/secrets", "err", "密钥不存在：%s", row.Name)
		return
	}
	redirectFlash(c, "/console/secrets", "ok", "密钥已删除：%s", row.Name)
}
