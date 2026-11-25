package settings

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	settingsdto "app-user/internal/dto/settings"
	settingsmodel "app-user/internal/model/settings"

	"gorm.io/gorm"
)

// OAuth 2.1 (authorization code + PKCE + dynamic client registration) for
// OAuth-only MCP servers (Figma, Notion, Linear, ...). Token material is stored
// AES-encrypted in user_mcp_oauth; app-ts never sees client secrets.

const (
	oauthStateTTL    = 10 * time.Minute
	oauthMaxBody     = 256 * 1024
	oauthDefaultTTL  = 10 * time.Second
	oauthScopeTarget = "mcp:connect"
)

var (
	// ErrMCPOAuthNotConfigured means the deployment has no browser-reachable
	// callback (settings.mcp.oauth.callback_url / frontend_url).
	ErrMCPOAuthNotConfigured = errors.New("OAuth 回调地址未配置")
	// ErrMCPOAuthNotAuthorized means the connection has no usable token.
	ErrMCPOAuthNotAuthorized = errors.New("MCP 连接尚未完成 OAuth 授权")
	// ErrMCPOAuthExpired means the refresh token is gone or rejected.
	ErrMCPOAuthExpired = errors.New("OAuth 授权已过期，请重新授权")
)

// MCPOAuthUpstreamError is an actionable failure from the provider's OAuth
// endpoints (e.g. Figma's allowlisted dynamic client registration).
type MCPOAuthUpstreamError struct{ msg string }

func (e *MCPOAuthUpstreamError) Error() string { return e.msg }

func oauthUpstreamInvalid(format string, args ...any) error {
	return &MCPOAuthUpstreamError{msg: fmt.Sprintf(format, args...)}
}

var resourceMetadataRe = regexp.MustCompile(`resource_metadata="([^"]+)"`)

type protectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

type authorizationServerMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	RegistrationEndpoint              string   `json:"registration_endpoint"`
	ScopesSupported                   []string `json:"scopes_supported"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
}

type oauthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
}

type oauthErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type oauthClientRegistration struct {
	ClientID                string `json:"client_id"`
	ClientSecret            string `json:"client_secret"`
	TokenEndpointAuthMethod string `json:"token_endpoint_auth_method"`
}

func randomOAuthToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()
}

// assertOAuthURL validates every discovered endpoint before we send the client
// secret, authorization code or refresh token to it (SSRF guard).
func (s *MCPService) assertOAuthURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, mcpInvalid("OAuth 端点地址不合法")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && s.oauthCfg.AllowPrivateHosts) {
		return nil, mcpInvalid("OAuth 端点必须是 https")
	}
	if s.oauthCfg.AllowPrivateHosts {
		return u, nil
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || host == "host.docker.internal" ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, mcpInvalid("OAuth 端点不能指向私网地址")
	}
	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return nil, mcpInvalid("OAuth 端点不能指向私网地址")
		}
		return u, nil
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return nil, mcpInvalid("OAuth 端点域名无法解析")
	}
	for _, ip := range ips {
		if isPrivateIP(ip) {
			return nil, mcpInvalid("OAuth 端点解析到私网地址，已拒绝")
		}
	}
	return u, nil
}

func (s *MCPService) oauthClient() *http.Client {
	timeout := time.Duration(s.oauthCfg.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = oauthDefaultTTL
	}
	return &http.Client{Timeout: timeout}
}

func (s *MCPService) oauthGetJSON(ctx context.Context, raw string, out any) error {
	u, err := s.assertOAuthURL(raw)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.oauthClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, oauthMaxBody))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// probeResourceMetadata reads the RFC 9728 discovery pointer from the MCP
// endpoint's 401 challenge when the origin well-known is absent.
func (s *MCPService) probeResourceMetadata(ctx context.Context, raw string) (string, error) {
	u, err := s.assertOAuthURL(raw)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := s.oauthClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, oauthMaxBody))
	if resp.StatusCode != http.StatusUnauthorized {
		return "", fmt.Errorf("MCP 未返回 OAuth 发现信息（HTTP %d）", resp.StatusCode)
	}
	m := resourceMetadataRe.FindStringSubmatch(resp.Header.Get("WWW-Authenticate"))
	if len(m) < 2 {
		return "", errors.New("MCP 401 未携带 resource_metadata")
	}
	return m[1], nil
}

// discoverOAuth resolves the protected-resource metadata and the authorization
// server metadata (RFC 9728 + RFC 8414).
func (s *MCPService) discoverOAuth(ctx context.Context, serverURL string) (*protectedResourceMetadata, *authorizationServerMetadata, error) {
	u, err := s.assertOAuthURL(serverURL)
	if err != nil {
		return nil, nil, err
	}
	origin := u.Scheme + "://" + u.Host
	var pr protectedResourceMetadata
	if err := s.oauthGetJSON(ctx, origin+"/.well-known/oauth-protected-resource", &pr); err != nil || len(pr.AuthorizationServers) == 0 {
		metaURL, perr := s.probeResourceMetadata(ctx, serverURL)
		if perr != nil {
			return nil, nil, fmt.Errorf("无法发现 MCP OAuth 元数据: %v", err)
		}
		if err := s.oauthGetJSON(ctx, metaURL, &pr); err != nil {
			return nil, nil, fmt.Errorf("无法读取 MCP OAuth 元数据: %v", err)
		}
	}
	if len(pr.AuthorizationServers) == 0 {
		return nil, nil, mcpInvalid("该 MCP Server 未声明授权服务器")
	}
	issuer := strings.TrimRight(pr.AuthorizationServers[0], "/")
	var as authorizationServerMetadata
	if err := s.oauthGetJSON(ctx, issuer+"/.well-known/oauth-authorization-server", &as); err != nil {
		if err2 := s.oauthGetJSON(ctx, issuer+"/.well-known/openid-configuration", &as); err2 != nil {
			return nil, nil, fmt.Errorf("无法读取授权服务器元数据: %v", err)
		}
	}
	if as.AuthorizationEndpoint == "" || as.TokenEndpoint == "" {
		return nil, nil, mcpInvalid("授权服务器缺少 authorization/token 端点")
	}
	return &pr, &as, nil
}

func pickOAuthScope(pr *protectedResourceMetadata, as *authorizationServerMetadata) string {
	for _, list := range [][]string{pr.ScopesSupported, as.ScopesSupported} {
		for _, sc := range list {
			if sc == oauthScopeTarget {
				return sc
			}
		}
	}
	if len(pr.ScopesSupported) > 0 {
		return strings.Join(pr.ScopesSupported, " ")
	}
	return strings.Join(as.ScopesSupported, " ")
}

func pickTokenAuthMethod(as *authorizationServerMetadata) string {
	hasNone, hasBasic, hasPost := false, false, false
	for _, m := range as.TokenEndpointAuthMethodsSupported {
		switch m {
		case "none":
			hasNone = true
		case "client_secret_basic":
			hasBasic = true
		case "client_secret_post":
			hasPost = true
		}
	}
	switch {
	case hasNone:
		return "none"
	case hasBasic:
		return "client_secret_basic"
	case hasPost:
		return "client_secret_post"
	default:
		return "none"
	}
}

func (s *MCPService) registerOAuthClient(ctx context.Context, as *authorizationServerMetadata, clientName, callbackURL, scope string) (*oauthClientRegistration, error) {
	if as.RegistrationEndpoint == "" {
		return nil, mcpInvalid("该授权服务器不支持动态客户端注册")
	}
	u, err := s.assertOAuthURL(as.RegistrationEndpoint)
	if err != nil {
		return nil, err
	}
	method := pickTokenAuthMethod(as)
	if strings.TrimSpace(clientName) == "" {
		clientName = "MindBase"
	}
	payload := map[string]any{
		"client_name":                clientName,
		"redirect_uris":              []string{callbackURL},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": method,
	}
	if scope != "" {
		payload["scope"] = scope
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := s.oauthClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, oauthMaxBody))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		detail := strings.TrimSpace(string(raw))
		if len(detail) > 300 {
			detail = detail[:300]
		}
		slog.Warn("[MCP_OAUTH] dynamic client registration rejected", "status", resp.StatusCode, "detail", detail)
		if resp.StatusCode == http.StatusForbidden {
			return nil, oauthUpstreamInvalid("该授权服务器拒绝了动态客户端注册（403），通常只允许白名单客户端（例如 Figma），无法用第三方客户端接入")
		}
		return nil, oauthUpstreamInvalid("动态客户端注册失败（HTTP %d）", resp.StatusCode)
	}
	var reg oauthClientRegistration
	if err := json.Unmarshal(raw, &reg); err != nil || reg.ClientID == "" {
		return nil, errors.New("动态客户端注册返回不合法")
	}
	if reg.TokenEndpointAuthMethod != "" {
		method = reg.TokenEndpointAuthMethod
	}
	reg.TokenEndpointAuthMethod = method
	return &reg, nil
}

func (s *MCPService) postOAuthToken(ctx context.Context, endpoint string, form url.Values, clientID, secret, method string) (*oauthTokenResponse, error) {
	u, err := s.assertOAuthURL(endpoint)
	if err != nil {
		return nil, err
	}
	form.Set("client_id", clientID)
	if method != "client_secret_basic" && secret != "" {
		form.Set("client_secret", secret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if method == "client_secret_basic" && secret != "" {
		req.SetBasicAuth(clientID, secret)
	}
	resp, err := s.oauthClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, oauthMaxBody))
	if resp.StatusCode != http.StatusOK {
		var oe oauthErrorResponse
		_ = json.Unmarshal(raw, &oe)
		msg := strings.TrimSpace(oe.Error)
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("换取 token 失败：%s", msg)
	}
	var tok oauthTokenResponse
	if err := json.Unmarshal(raw, &tok); err != nil || tok.AccessToken == "" {
		return nil, errors.New("token 响应不合法")
	}
	return &tok, nil
}

// StartOAuth discovers the provider, registers this deployment as a client and
// returns the authorization URL the browser must visit.
func (s *MCPService) StartOAuth(ctx context.Context, uid, id int64) (*settingsdto.MCPOAuthStart, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	callback := strings.TrimSpace(s.oauthCfg.CallbackURL)
	frontend := strings.TrimSpace(s.oauthCfg.FrontendURL)
	if callback == "" || frontend == "" {
		return nil, ErrMCPOAuthNotConfigured
	}
	db := s.db.WithContext(ctx)
	server, err := s.repo.GetByID(db, uid, id)
	if err != nil {
		return nil, err
	}
	if server == nil {
		return nil, ErrMCPNotFound
	}
	pr, as, err := s.discoverOAuth(ctx, server.URL)
	if err != nil {
		return nil, err
	}
	scope := strings.TrimSpace(s.oauthCfg.Scopes)
	if scope == "" {
		scope = pickOAuthScope(pr, as)
	}
	var reg *oauthClientRegistration
	if strings.TrimSpace(s.oauthCfg.ClientID) != "" {
		// Pre-registered client: the provider issued credentials instead of
		// allowing dynamic registration (common for enterprise/allowlisted apps).
		method := "none"
		if strings.TrimSpace(s.oauthCfg.ClientSecret) != "" {
			method = "client_secret_basic"
		}
		reg = &oauthClientRegistration{
			ClientID:                strings.TrimSpace(s.oauthCfg.ClientID),
			ClientSecret:            strings.TrimSpace(s.oauthCfg.ClientSecret),
			TokenEndpointAuthMethod: method,
		}
	} else {
		reg, err = s.registerOAuthClient(ctx, as, s.oauthCfg.ClientName, callback, scope)
		if err != nil {
			return nil, err
		}
	}
	verifier := randomOAuthToken(32)
	state := randomOAuthToken(24)
	verifierEnc, err := s.seal(verifier)
	if err != nil {
		return nil, err
	}
	if verifierEnc == nil {
		return nil, ErrMCPCipherMissing
	}
	var secretEnc *string
	if reg.ClientSecret != "" {
		if secretEnc, err = s.seal(reg.ClientSecret); err != nil {
			return nil, err
		}
	}
	resource := strings.TrimSpace(pr.Resource)
	if resource == "" {
		resource = server.URL
	}
	expires := time.Now().Add(oauthStateTTL)
	_ = s.oauthRepo.DeleteExpiredStates(db, time.Now())
	st := &settingsmodel.UserMCPOAuthState{
		State:           state,
		UID:             uid,
		ServerID:        server.ID,
		Issuer:          strings.TrimRight(as.Issuer, "/"),
		TokenEndpoint:   as.TokenEndpoint,
		ClientID:        reg.ClientID,
		ClientSecretEnc: secretEnc,
		TokenAuthMethod: reg.TokenEndpointAuthMethod,
		CodeVerifierEnc: *verifierEnc,
		RedirectURI:     callback,
		ExpiresAt:       expires,
	}
	if scope != "" {
		st.Scope = &scope
	}
	if resource != "" {
		st.Resource = &resource
	}
	if err := s.oauthRepo.CreateState(db, st); err != nil {
		return nil, err
	}
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {reg.ClientID},
		"redirect_uri":          {callback},
		"state":                 {state},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	if resource != "" {
		q.Set("resource", resource)
	}
	authURL := as.AuthorizationEndpoint
	if strings.Contains(authURL, "?") {
		authURL += "&" + q.Encode()
	} else {
		authURL += "?" + q.Encode()
	}
	slog.Info("[MCP_OAUTH] authorization started", "uid", uid, "server_id", server.ID, "issuer", st.Issuer)
	return &settingsdto.MCPOAuthStart{AuthorizationURL: authURL, ExpiresAt: expires.UnixMilli()}, nil
}

func oauthRedirect(base, status, serverID, message string) string {
	if base == "" {
		return base
	}
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	q.Set("oauth", status)
	if serverID != "" {
		q.Set("server", serverID)
	}
	if message != "" {
		q.Set("message", message)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// CompleteOAuth consumes the state, exchanges the code and stores the tokens.
// It always returns a frontend redirect URL (success or failure).
func (s *MCPService) CompleteOAuth(ctx context.Context, state, code, providerError string) string {
	frontend := strings.TrimSpace(s.oauthCfg.FrontendURL)
	fail := func(msg string) string {
		return oauthRedirect(frontend, "error", "", msg)
	}
	if state == "" {
		return fail("缺少 state 参数")
	}
	db := s.db.WithContext(ctx)
	pending, err := s.oauthRepo.GetState(db, state)
	if err != nil || pending == nil {
		return fail("授权请求不存在或已使用")
	}
	if pending.ExpiresAt.Before(time.Now()) {
		_, _ = s.oauthRepo.DeleteState(db, state)
		return fail("授权请求已过期，请重新发起")
	}
	consumed, err := s.oauthRepo.DeleteState(db, state)
	if err != nil || !consumed {
		return fail("授权请求已被使用，请重新发起")
	}
	serverID := strconv.FormatInt(pending.ServerID, 10)
	if providerError != "" {
		return oauthRedirect(frontend, "error", serverID, "授权被拒绝："+providerError)
	}
	if code == "" {
		return oauthRedirect(frontend, "error", serverID, "缺少授权码")
	}
	verifier, err := s.open(&pending.CodeVerifierEnc)
	if err != nil {
		return oauthRedirect(frontend, "error", serverID, "授权请求已损坏")
	}
	var secret string
	if pending.ClientSecretEnc != nil {
		if secret, err = s.open(pending.ClientSecretEnc); err != nil {
			return oauthRedirect(frontend, "error", serverID, "授权请求已损坏")
		}
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {pending.RedirectURI},
		"code_verifier": {verifier},
	}
	tok, err := s.postOAuthToken(ctx, pending.TokenEndpoint, form, pending.ClientID, secret, pending.TokenAuthMethod)
	if err != nil {
		slog.Warn("[MCP_OAUTH] code exchange failed", "uid", pending.UID, "server_id", pending.ServerID, "err", err)
		return oauthRedirect(frontend, "error", serverID, "换取授权令牌失败，请重试")
	}
	accessEnc, err := s.seal(tok.AccessToken)
	if err != nil || accessEnc == nil {
		return oauthRedirect(frontend, "error", serverID, "服务端未能保存令牌")
	}
	var refreshEnc *string
	if tok.RefreshToken != "" {
		if refreshEnc, err = s.seal(tok.RefreshToken); err != nil {
			return oauthRedirect(frontend, "error", serverID, "服务端未能保存令牌")
		}
	}
	now := time.Now()
	var expiresAt *time.Time
	if tok.ExpiresIn > 0 {
		t := now.Add(time.Duration(tok.ExpiresIn) * time.Second)
		expiresAt = &t
	}
	method := pending.TokenAuthMethod
	row := &settingsmodel.UserMCPOAuth{
		UID:             pending.UID,
		ServerID:        pending.ServerID,
		Issuer:          pending.Issuer,
		TokenEndpoint:   pending.TokenEndpoint,
		ClientID:        pending.ClientID,
		ClientSecretEnc: pending.ClientSecretEnc,
		TokenAuthMethod: &method,
		Scope:           scopePointer(tok.Scope, pending.Scope),
		Resource:        pending.Resource,
		AccessTokenEnc:  accessEnc,
		RefreshTokenEnc: refreshEnc,
		ExpiresAt:       expiresAt,
		AuthorizedAt:    &now,
	}
	if tok.TokenType != "" {
		row.TokenType = &tok.TokenType
	}
	if err := s.oauthRepo.Upsert(db, row); err != nil {
		slog.Error("[MCP_OAUTH] persist tokens failed", "uid", pending.UID, "server_id", pending.ServerID, "err", err)
		return oauthRedirect(frontend, "error", serverID, "服务端未能保存令牌")
	}
	// The connection now authenticates via OAuth; drop the static key so the two
	// credential models cannot mask each other.
	_, _ = s.repo.UpdateFields(db, pending.UID, pending.ServerID, map[string]any{
		"auth_kind":   "oauth",
		"auth_header": nil,
		"api_key_enc": nil,
		"tools_json":  "[]",
		"last_error":  nil,
	})
	slog.Info("[MCP_OAUTH] authorized", "uid", pending.UID, "server_id", pending.ServerID, "issuer", pending.Issuer)
	return oauthRedirect(frontend, "ok", serverID, "")
}

func scopePointer(echoed string, fallback *string) *string {
	if echoed != "" {
		return &echoed
	}
	return fallback
}

// RefreshOAuth rotates the access token using the stored refresh token.
func (s *MCPService) RefreshOAuth(ctx context.Context, uid, id int64) (*settingsdto.MCPOAuthToken, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	row, err := s.oauthRepo.Get(db, uid, id)
	if err != nil {
		return nil, err
	}
	if row == nil || row.RefreshTokenEnc == nil {
		return nil, ErrMCPOAuthNotAuthorized
	}
	refresh, err := s.open(row.RefreshTokenEnc)
	if err != nil {
		return nil, ErrMCPOAuthExpired
	}
	var secret string
	if row.ClientSecretEnc != nil {
		if secret, err = s.open(row.ClientSecretEnc); err != nil {
			return nil, ErrMCPOAuthExpired
		}
	}
	method := "none"
	if row.TokenAuthMethod != nil && *row.TokenAuthMethod != "" {
		method = *row.TokenAuthMethod
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
	}
	tok, err := s.postOAuthToken(ctx, row.TokenEndpoint, form, row.ClientID, secret, method)
	if err != nil {
		slog.Warn("[MCP_OAUTH] refresh failed", "uid", uid, "server_id", id, "err", err)
		return nil, ErrMCPOAuthExpired
	}
	accessEnc, err := s.seal(tok.AccessToken)
	if err != nil || accessEnc == nil {
		return nil, ErrMCPCipherMissing
	}
	if tok.RefreshToken != "" {
		if row.RefreshTokenEnc, err = s.seal(tok.RefreshToken); err != nil {
			return nil, err
		}
	}
	row.AccessTokenEnc = accessEnc
	var expiresAt *time.Time
	if tok.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		expiresAt = &t
	}
	row.ExpiresAt = expiresAt
	if tok.Scope != "" {
		row.Scope = &tok.Scope
	}
	if err := s.oauthRepo.Upsert(db, row); err != nil {
		return nil, err
	}
	out := &settingsdto.MCPOAuthToken{AccessToken: tok.AccessToken}
	if expiresAt != nil {
		out.ExpiresAt = expiresAt.UnixMilli()
	}
	return out, nil
}

// DisconnectOAuth removes the stored tokens and falls the connection back to
// unauthenticated until the user authorizes again.
func (s *MCPService) DisconnectOAuth(ctx context.Context, uid, id int64) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	db := s.db.WithContext(ctx)
	current, err := s.repo.GetByID(db, uid, id)
	if err != nil {
		return err
	}
	if current == nil {
		return ErrMCPNotFound
	}
	if _, err := s.oauthRepo.Delete(db, uid, id); err != nil {
		return err
	}
	_, err = s.repo.UpdateFields(db, uid, id, map[string]any{
		"auth_kind":   "none",
		"auth_header": nil,
		"api_key_enc": nil,
		"tools_json":  "[]",
		"last_error":  nil,
	})
	return err
}

// oauthAuthorized reports whether the connection has a stored token (used by
// the user/internal DTO so the UI can show 授权状态).
func (s *MCPService) oauthAuthorized(db *gorm.DB, uid, serverID int64) (*settingsmodel.UserMCPOAuth, error) {
	return s.oauthRepo.Get(db, uid, serverID)
}
