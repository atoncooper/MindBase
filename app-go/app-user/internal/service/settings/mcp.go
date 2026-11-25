// Per-user MCP connections — settings-domain business logic.
//
// A connection is user configuration (endpoint + API key), so storage and
// CRUD live here in app-user next to coding_plans. app-ts owns the MCP
// protocol (tools/list, tools/call) and reads the decrypted list through the
// internal M2M face; this service never talks MCP.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"

	"app-user/internal/config"
	settingsdto "app-user/internal/dto/settings"
	"app-user/internal/infra/security"
	settingsmodel "app-user/internal/model/settings"
	settingsrepo "app-user/internal/repo/settings"

	"gorm.io/gorm"
)

const (
	// DefaultMaxMCPServers is the per-uid cap when config is absent.
	DefaultMaxMCPServers = 10
	maxMCPServerName     = 32
	maxMCPServerURL      = 500
	maxMCPAPIKey         = 4096
	maxMCPAuthHeader     = 64
	maxMCPLastError      = 500
	maxMCPTools          = 200
	maxMCPToolDesc       = 500
	maxMCPToolsJSON      = 256 * 1024
)

// MCP business errors — the router maps them to HTTP statuses.
var (
	ErrMCPDisabled      = errors.New("用户 MCP 功能未启用")
	ErrMCPNotFound      = errors.New("MCP server 不存在")
	ErrMCPNameTaken     = errors.New("MCP 名称已存在")
	ErrMCPLimit         = errors.New("MCP server 数量已达上限")
	ErrMCPCipherMissing = errors.New("服务端未配置密钥加密，暂时不能保存 API Key")
)

// MCPValidationError marks caller-fixable input errors (HTTP 400).
type MCPValidationError struct{ msg string }

func (e *MCPValidationError) Error() string { return e.msg }

func mcpInvalid(format string, args ...any) error {
	return &MCPValidationError{msg: fmt.Sprintf(format, args...)}
}

var (
	mcpNamePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	mcpHeaderPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`)
)

// MCPInput is a create payload (already bound by the router DTO).
type MCPInput struct {
	Name       string
	URL        string
	AuthKind   string
	APIKey     string
	AuthHeader string
	Enabled    *bool
}

// MCPPatch is a partial update; nil fields are untouched and an empty key
// means "keep the stored key" (unless auth_kind switches to none).
type MCPPatch struct {
	Name       *string
	URL        *string
	AuthKind   *string
	APIKey     *string
	AuthHeader *string
	Enabled    *bool
}

// MCPService owns the per-user MCP connection table.
type MCPService struct {
	db         *gorm.DB
	cipher     *security.Cipher
	repo       *settingsrepo.MCPRepo
	oauthRepo  *settingsrepo.MCPOAuthRepo
	oauthCfg   config.MCPOAuthConfig
	enabled    bool
	maxServers int
}

// NewMCPService builds the service. cipher is the shared settings-domain
// AES cipher (SECURITY__API_KEY_ENCRYPTION_KEY), same one coding_plans uses.
func NewMCPService(db *gorm.DB, cipher *security.Cipher, cfg config.MCPConfig) *MCPService {
	max := cfg.MaxServers
	if max <= 0 {
		max = DefaultMaxMCPServers
	}
	return &MCPService{
		db:         db,
		cipher:     cipher,
		repo:       settingsrepo.NewMCPRepo(),
		oauthRepo:  settingsrepo.NewMCPOAuthRepo(),
		oauthCfg:   cfg.OAuth,
		enabled:    cfg.Enabled,
		maxServers: max,
	}
}

// Enabled reports whether the feature is on and the DB is wired.
func (s *MCPService) Enabled() bool { return s != nil && s.enabled && s.db != nil }

func (s *MCPService) requireEnabled() error {
	if !s.Enabled() {
		return ErrMCPDisabled
	}
	return nil
}

// ── user CRUD ────────────────────────────────────────────────────────

// ListServers returns the caller's connections (masked keys, discovered tools).
func (s *MCPService) ListServers(ctx context.Context, uid int64) ([]settingsdto.MCPServer, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	rows, err := s.repo.ListByUID(db, uid)
	if err != nil {
		return nil, err
	}
	out := make([]settingsdto.MCPServer, 0, len(rows))
	for i := range rows {
		var oauth *settingsmodel.UserMCPOAuth
		if rows[i].AuthKind == "oauth" {
			if oauth, err = s.oauthRepo.Get(db, uid, rows[i].ID); err != nil {
				return nil, err
			}
		}
		out = append(out, s.toUserDTO(&rows[i], oauth))
	}
	return out, nil
}

// CreateServer stores a new connection. Tool discovery happens in app-ts, so a
// saved-but-unreachable server stays visible with last_error instead of
// losing the user's input.
func (s *MCPService) CreateServer(ctx context.Context, uid int64, in MCPInput) (*settingsdto.MCPServer, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	count, err := s.repo.CountByUID(db, uid)
	if err != nil {
		return nil, err
	}
	if count >= int64(s.maxServers) {
		return nil, ErrMCPLimit
	}
	name, err := normalizeMCPName(in.Name)
	if err != nil {
		return nil, err
	}
	rawURL, err := normalizeMCPURL(in.URL)
	if err != nil {
		return nil, err
	}
	kind, header, err := normalizeMCPAuth(in.AuthKind, in.AuthHeader)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(in.APIKey)
	if kind == "none" || kind == "oauth" {
		key = ""
	}
	if kind != "none" && kind != "oauth" && key == "" {
		return nil, mcpInvalid("当前鉴权方式需要填写 API Key")
	}
	if len(key) > maxMCPAPIKey {
		return nil, mcpInvalid("API Key 过长")
	}
	existing, err := s.repo.GetByName(db, uid, name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrMCPNameTaken
	}
	sealed, err := s.seal(key)
	if err != nil {
		return nil, err
	}
	enabled := in.Enabled == nil || *in.Enabled
	row := &settingsmodel.UserMCPServer{
		UID:       uid,
		Name:      name,
		URL:       rawURL,
		AuthKind:  kind,
		Enabled:   &enabled,
		ToolsJSON: strPtr("[]"),
	}
	if header != "" {
		row.AuthHeader = &header
	}
	if sealed != nil {
		row.APIKeyEnc = sealed
	}
	if err := s.repo.Create(db, row); err != nil {
		return nil, err
	}
	dto := s.toUserDTO(row, nil)
	return &dto, nil
}

// UpdateServer patches a connection. Changing the URL or the credential clears the
// cached tool list (app-ts re-discovers on the next save/test), so a stale
// catalog can never point at an old endpoint.
func (s *MCPService) UpdateServer(ctx context.Context, uid, id int64, p MCPPatch) (*settingsdto.MCPServer, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	current, err := s.repo.GetByID(db, uid, id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, ErrMCPNotFound
	}
	name := current.Name
	if p.Name != nil {
		if name, err = normalizeMCPName(*p.Name); err != nil {
			return nil, err
		}
	}
	rawURL := current.URL
	if p.URL != nil {
		if rawURL, err = normalizeMCPURL(*p.URL); err != nil {
			return nil, err
		}
	}
	kind := current.AuthKind
	if p.AuthKind != nil {
		kind = strings.ToLower(strings.TrimSpace(*p.AuthKind))
	}
	header := derefStr(current.AuthHeader)
	if p.AuthHeader != nil {
		header = *p.AuthHeader
	}
	if kind, header, err = normalizeMCPAuth(kind, header); err != nil {
		return nil, err
	}
	existingKey, err := s.open(current.APIKeyEnc)
	if err != nil {
		return nil, err
	}
	key := existingKey
	if p.APIKey != nil && strings.TrimSpace(*p.APIKey) != "" {
		key = strings.TrimSpace(*p.APIKey)
	}
	if kind == "none" || kind == "oauth" {
		key = ""
		header = ""
	}
	if kind != "none" && kind != "oauth" && key == "" {
		return nil, mcpInvalid("当前鉴权方式需要填写 API Key")
	}
	if len(key) > maxMCPAPIKey {
		return nil, mcpInvalid("API Key 过长")
	}
	if p.Name != nil && name != current.Name {
		dup, derr := s.repo.GetByName(db, uid, name)
		if derr != nil {
			return nil, derr
		}
		if dup != nil {
			return nil, ErrMCPNameTaken
		}
	}
	enabled := current.Enabled == nil || *current.Enabled
	if p.Enabled != nil {
		enabled = *p.Enabled
	}
	credentialChanged := key != existingKey || kind != current.AuthKind || header != derefStr(current.AuthHeader)
	endpointChanged := rawURL != current.URL
	fields := map[string]any{
		"name":      name,
		"url":       rawURL,
		"auth_kind": kind,
		"enabled":   enabled,
	}
	if header == "" {
		fields["auth_header"] = nil
	} else {
		fields["auth_header"] = header
	}
	if credentialChanged {
		sealed, serr := s.seal(key)
		if serr != nil {
			return nil, serr
		}
		if sealed == nil {
			fields["api_key_enc"] = nil
		} else {
			fields["api_key_enc"] = *sealed
		}
	}
	if endpointChanged || credentialChanged {
		fields["tools_json"] = "[]"
		fields["last_error"] = nil
	}
	if kind != "oauth" && current.AuthKind == "oauth" {
		if _, err := s.oauthRepo.Delete(db, uid, id); err != nil {
			return nil, err
		}
	}
	if kind == "oauth" && endpointChanged {
		// Tokens are bound to the resource; a new URL needs a fresh grant.
		if _, err := s.oauthRepo.Delete(db, uid, id); err != nil {
			return nil, err
		}
	}
	ok, err := s.repo.UpdateFields(db, uid, id, fields)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMCPNotFound
	}
	updated, err := s.repo.GetByID(db, uid, id)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, ErrMCPNotFound
	}
	var oauth *settingsmodel.UserMCPOAuth
	if updated.AuthKind == "oauth" {
		if oauth, err = s.oauthRepo.Get(db, uid, id); err != nil {
			return nil, err
		}
	}
	dto := s.toUserDTO(updated, oauth)
	return &dto, nil
}

// DeleteServer removes one connection.
func (s *MCPService) DeleteServer(ctx context.Context, uid, id int64) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	ok, err := s.repo.Delete(s.db.WithContext(ctx), uid, id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMCPNotFound
	}
	return nil
}

// ── internal M2M face (app-ts) ───────────────────────────────────────

// InternalServers returns every connection for uid with the decrypted API key.
// This is the only face that carries plaintext credentials; the caller is
// authenticated by the shared internal key at the gateway/router layer.
func (s *MCPService) InternalServers(ctx context.Context, uid int64) ([]settingsdto.InternalMCPServer, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	rows, err := s.repo.ListByUID(db, uid)
	if err != nil {
		return nil, err
	}
	out := make([]settingsdto.InternalMCPServer, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		key, err := s.open(row.APIKeyEnc)
		if err != nil {
			return nil, err
		}
		item := settingsdto.InternalMCPServer{
			ID:         row.ID,
			Name:       row.Name,
			URL:        row.URL,
			AuthKind:   row.AuthKind,
			AuthHeader: derefStr(row.AuthHeader),
			APIKey:     key,
			Enabled:    row.Enabled == nil || *row.Enabled,
			Tools:      decodeMCPTools(row.ToolsJSON),
			LastError:  derefStr(row.LastError),
		}
		if row.AuthKind == "oauth" {
			oauth, oerr := s.oauthRepo.Get(db, uid, row.ID)
			if oerr != nil {
				return nil, oerr
			}
			if oauth != nil && oauth.AccessTokenEnc != nil {
				if token, terr := s.open(oauth.AccessTokenEnc); terr == nil {
					item.AccessToken = token
				}
				item.OAuthAuthorized = true
				if oauth.ExpiresAt != nil {
					item.ExpiresAt = oauth.ExpiresAt.UnixMilli()
				}
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// RecordDiscovery stores the tools/list result app-ts discovered. It is a
// cache for the settings page and the chat catalog, not a credential write.
func (s *MCPService) RecordDiscovery(ctx context.Context, uid, id int64, tools []settingsdto.MCPTool, lastError string) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	clean := make([]settingsdto.MCPTool, 0, len(tools))
	for _, t := range tools {
		name := strings.TrimSpace(t.Name)
		if name == "" {
			continue
		}
		desc := strings.TrimSpace(t.Description)
		if len(desc) > maxMCPToolDesc {
			desc = desc[:maxMCPToolDesc]
		}
		clean = append(clean, settingsdto.MCPTool{Name: name, Description: desc})
		if len(clean) >= maxMCPTools {
			break
		}
	}
	raw, err := json.Marshal(clean)
	if err != nil {
		return err
	}
	if len(raw) > maxMCPToolsJSON {
		return mcpInvalid("工具列表过长")
	}
	msg := strings.TrimSpace(lastError)
	if len(msg) > maxMCPLastError {
		msg = msg[:maxMCPLastError]
	}
	fields := map[string]any{"tools_json": string(raw)}
	if msg == "" {
		fields["last_error"] = nil
	} else {
		fields["last_error"] = msg
	}
	ok, err := s.repo.UpdateFields(s.db.WithContext(ctx), uid, id, fields)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMCPNotFound
	}
	return nil
}

// ── helpers ─────────────────────────────────────────────────────────

func (s *MCPService) seal(key string) (*string, error) {
	if key == "" {
		return nil, nil
	}
	if s.cipher == nil {
		return nil, ErrMCPCipherMissing
	}
	enc, err := s.cipher.Encrypt(key)
	if err != nil {
		return nil, fmt.Errorf("encrypt mcp api key: %w", err)
	}
	return &enc, nil
}

func (s *MCPService) open(sealed *string) (string, error) {
	if sealed == nil || *sealed == "" {
		return "", nil
	}
	if s.cipher == nil {
		return "", ErrMCPCipherMissing
	}
	key, err := s.cipher.Decrypt(*sealed)
	if err != nil {
		return "", fmt.Errorf("decrypt mcp api key: %w", err)
	}
	return key, nil
}

func (s *MCPService) toUserDTO(row *settingsmodel.UserMCPServer, oauth *settingsmodel.UserMCPOAuth) settingsdto.MCPServer {
	key, err := s.open(row.APIKeyEnc)
	if err != nil {
		slog.Warn("[MCP] mask decrypt failed", "uid", row.UID, "id", row.ID, "err", err)
		key = ""
	}
	dto := settingsdto.MCPServer{
		ID:           row.ID,
		Name:         row.Name,
		URL:          row.URL,
		AuthKind:     row.AuthKind,
		AuthHeader:   derefStr(row.AuthHeader),
		APIKeyMasked: settingsdto.MaskMCPKey(key),
		Enabled:      row.Enabled == nil || *row.Enabled,
		Tools:        decodeMCPTools(row.ToolsJSON),
		LastError:    derefStr(row.LastError),
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}
	if oauth != nil && oauth.AccessTokenEnc != nil {
		dto.OAuthAuthorized = true
		dto.OAuthIssuer = oauth.Issuer
		dto.OAuthExpiresAt = oauth.ExpiresAt
	}
	return dto
}

func decodeMCPTools(raw *string) []settingsdto.MCPTool {
	out := []settingsdto.MCPTool{}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return out
	}
	if err := json.Unmarshal([]byte(*raw), &out); err != nil {
		return []settingsdto.MCPTool{}
	}
	if out == nil {
		out = []settingsdto.MCPTool{}
	}
	return out
}

func normalizeMCPName(raw string) (string, error) {
	name := strings.ToLower(strings.TrimSpace(raw))
	if name == "" {
		return "", mcpInvalid("MCP 名称必填")
	}
	if len(name) > maxMCPServerName || !mcpNamePattern.MatchString(name) {
		return "", mcpInvalid("MCP 名称需为 1-32 位小写字母、数字、_ 或 -")
	}
	return name, nil
}

func normalizeMCPURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", mcpInvalid("MCP URL 必填")
	}
	if len(raw) > maxMCPServerURL {
		return "", mcpInvalid("MCP URL 过长")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", mcpInvalid("MCP URL 不合法")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", mcpInvalid("MCP 仅支持 http/https")
	}
	if u.User != nil {
		return "", mcpInvalid("MCP URL 不能包含用户名/密码")
	}
	return u.String(), nil
}

// normalizeMCPAuth maps the user's auth choice to (kind, header). The API key
// itself is validated by the caller so updates can keep the stored key.
func normalizeMCPAuth(rawKind, rawHeader string) (string, string, error) {
	switch strings.ToLower(strings.TrimSpace(rawKind)) {
	case "", "none":
		return "none", "", nil
	case "bearer":
		return "bearer", "", nil
	case "header":
		header := strings.TrimSpace(rawHeader)
		if header == "" {
			return "", "", mcpInvalid("请填写 API Key 的 Header 名称（例如 X-API-Key）")
		}
		if len(header) > maxMCPAuthHeader || !mcpHeaderPattern.MatchString(header) {
			return "", "", mcpInvalid("Header 名称不合法")
		}
		return "header", header, nil
	case "oauth":
		return "oauth", "", nil
	default:
		return "", "", mcpInvalid("鉴权方式不支持")
	}
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strPtr(s string) *string { return &s }
