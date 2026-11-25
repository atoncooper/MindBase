package settings

import "time"

// ── Per-user MCP connections (/settings/mcp/servers, settings domain) ──
//
// Credentials are API keys, not free-form headers: bearer → Authorization,
// header → one custom header name. The plaintext key is write-only and is
// only ever served on the internal M2M face consumed by app-ts.

// MCPServerCreateRequest is POST /settings/mcp/servers.
type MCPServerCreateRequest struct {
	Name       string `json:"name" binding:"required"`
	URL        string `json:"url" binding:"required"`
	AuthKind   string `json:"auth_kind"`   // none | bearer | header (default none)
	APIKey     string `json:"api_key"`     // write-only
	AuthHeader string `json:"auth_header"` // only for auth_kind=header
	Enabled    *bool  `json:"enabled"`
}

// MCPServerUpdateRequest is PATCH /settings/mcp/servers/{id}. Every field is
// optional; an empty api_key keeps the stored key.
type MCPServerUpdateRequest struct {
	Name       *string `json:"name"`
	URL        *string `json:"url"`
	AuthKind   *string `json:"auth_kind"`
	APIKey     *string `json:"api_key"`
	AuthHeader *string `json:"auth_header"`
	Enabled    *bool   `json:"enabled"`
}

// MCPTool is one tool discovered by app-ts through MCP tools/list.
type MCPTool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// MCPServer is the safe user-face wire shape: api_key is replaced by a mask.
type MCPServer struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	URL          string    `json:"url"`
	AuthKind     string    `json:"auth_kind"`
	AuthHeader   string    `json:"auth_header,omitempty"`
	APIKeyMasked string    `json:"api_key_masked,omitempty"`
	Enabled      bool      `json:"enabled"`
	Tools        []MCPTool `json:"tools"`
	LastError    string    `json:"last_error,omitempty"`
	// OAuth 2.1 state (auth_kind=oauth): authorized means a stored token exists.
	OAuthAuthorized bool       `json:"oauth_authorized"`
	OAuthIssuer     string     `json:"oauth_issuer,omitempty"`
	OAuthExpiresAt  *time.Time `json:"oauth_expires_at,omitempty"`
	CreatedAt       *time.Time `json:"created_at,omitempty"`
	UpdatedAt       *time.Time `json:"updated_at,omitempty"`
}

// MCPServers is GET /settings/mcp/servers.
type MCPServers struct {
	Enabled bool        `json:"enabled"`
	Servers []MCPServer `json:"servers"`
}

// MCPServerEnvelope is the POST/PATCH response.
type MCPServerEnvelope struct {
	Server MCPServer `json:"server"`
}

// MCPDiscoveryRequest is PATCH /internal/settings/mcp/{uid}/{id}/discovery —
// app-ts writes back the tools/list result (it owns the MCP protocol).
type MCPDiscoveryRequest struct {
	Tools     []MCPTool `json:"tools"`
	LastError string    `json:"last_error"`
}

// InternalMCPServer is the M2M shape: the ONLY face carrying the plaintext
// API key (apikey-guarded, consumed by app-ts).
type InternalMCPServer struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	AuthKind   string    `json:"auth_kind"`
	AuthHeader string    `json:"auth_header,omitempty"`
	APIKey     string    `json:"api_key,omitempty"`
	Enabled    bool      `json:"enabled"`
	Tools      []MCPTool `json:"tools"`
	LastError  string    `json:"last_error,omitempty"`
	// OAuth (auth_kind=oauth): the decrypted access token + expiry; the caller
	// refreshes through /internal/settings/mcp/{uid}/{id}/refresh when stale.
	AccessToken     string `json:"access_token,omitempty"`
	ExpiresAt       int64  `json:"expires_at,omitempty"`
	OAuthAuthorized bool   `json:"oauth_authorized,omitempty"`
}

// InternalMCPServers is GET /internal/settings/mcp/{uid}.
type InternalMCPServers struct {
	Enabled bool                `json:"enabled"`
	Servers []InternalMCPServer `json:"servers"`
}

// MaskMCPKey masks an API key for the user-facing response. The middle is
// never echoed; short keys collapse to a fixed mask.
func MaskMCPKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "****"
	}
	return key[:3] + "****" + key[len(key)-4:]
}

// MCPOAuthStart is POST /settings/mcp/servers/{id}/oauth/start.
type MCPOAuthStart struct {
	AuthorizationURL string `json:"authorization_url"`
	ExpiresAt        int64  `json:"expires_at"`
}

// MCPOAuthToken is the internal refresh response.
type MCPOAuthToken struct {
	AccessToken string `json:"access_token"`
	ExpiresAt   int64  `json:"expires_at,omitempty"`
}
