package model

import "time"

// UserMCPOAuth — OAuth 2.1 credentials for one per-user MCP connection.
//
// Stored separately from user_mcp_servers so the settings schema stays
// CREATE-only (no ALTER on the live table): auth_kind='oauth' on the server row
// plus this companion row. All secrets are AES-256-GCM ciphertext.
type UserMCPOAuth struct {
	UID             int64      `gorm:"column:uid;primaryKey" json:"uid"`
	ServerID        int64      `gorm:"column:server_id;primaryKey" json:"server_id"`
	Issuer          string     `gorm:"column:issuer" json:"issuer"`
	TokenEndpoint   string     `gorm:"column:token_endpoint" json:"token_endpoint"`
	ClientID        string     `gorm:"column:client_id" json:"client_id"`
	ClientSecretEnc *string    `gorm:"column:client_secret_enc" json:"-"`
	TokenAuthMethod *string    `gorm:"column:token_auth_method" json:"token_auth_method"`
	Scope           *string    `gorm:"column:scope" json:"scope"`
	Resource        *string    `gorm:"column:resource" json:"resource"`
	AccessTokenEnc  *string    `gorm:"column:access_token_enc" json:"-"`
	RefreshTokenEnc *string    `gorm:"column:refresh_token_enc" json:"-"`
	ExpiresAt       *time.Time `gorm:"column:expires_at" json:"expires_at"`
	TokenType       *string    `gorm:"column:token_type" json:"token_type"`
	AuthorizedAt    *time.Time `gorm:"column:authorized_at" json:"authorized_at"`
	CreatedAt       *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt       *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (UserMCPOAuth) TableName() string { return "user_mcp_oauth" }

// UserMCPOAuthState — a pending authorization request (single use, short TTL).
// state is the opaque CSRF token carried through the provider redirect; the
// PKCE verifier and dynamically-registered client credentials live here until
// the callback exchanges the code.
type UserMCPOAuthState struct {
	State           string     `gorm:"column:state;primaryKey" json:"state"`
	UID             int64      `gorm:"column:uid" json:"uid"`
	ServerID        int64      `gorm:"column:server_id" json:"server_id"`
	Issuer          string     `gorm:"column:issuer" json:"issuer"`
	TokenEndpoint   string     `gorm:"column:token_endpoint" json:"token_endpoint"`
	ClientID        string     `gorm:"column:client_id" json:"client_id"`
	ClientSecretEnc *string    `gorm:"column:client_secret_enc" json:"-"`
	TokenAuthMethod string     `gorm:"column:token_auth_method" json:"token_auth_method"`
	CodeVerifierEnc string     `gorm:"column:code_verifier_enc" json:"-"`
	RedirectURI     string     `gorm:"column:redirect_uri" json:"redirect_uri"`
	Scope           *string    `gorm:"column:scope" json:"scope"`
	Resource        *string    `gorm:"column:resource" json:"resource"`
	ExpiresAt       time.Time  `gorm:"column:expires_at" json:"expires_at"`
	CreatedAt       *time.Time `gorm:"column:created_at" json:"created_at"`
}

func (UserMCPOAuthState) TableName() string { return "user_mcp_oauth_states" }
