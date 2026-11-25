package model

import "time"

// UserMCPServer — a per-user third-party MCP connection. It is user
// configuration (settings domain), not identity, so the table is owned by
// internal/infra/db/settings like coding_plans. APIKeyEnc holds AES-256-GCM
// ciphertext (never plaintext) and is never serialized.
//
// AuthKind: none | bearer (Authorization: Bearer <key>) | header (custom
// header name + key). AuthHeader is only meaningful for header.
type UserMCPServer struct {
	ID         int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID        int64      `gorm:"column:uid" json:"uid"`
	Name       string     `gorm:"column:name" json:"name"`
	URL        string     `gorm:"column:url" json:"url"`
	AuthKind   string     `gorm:"column:auth_kind" json:"auth_kind"`
	AuthHeader *string    `gorm:"column:auth_header" json:"auth_header"`
	APIKeyEnc  *string    `gorm:"column:api_key_enc" json:"-"`
	Enabled    *bool      `gorm:"column:enabled" json:"enabled"`
	ToolsJSON  *string    `gorm:"column:tools_json" json:"-"`
	LastError  *string    `gorm:"column:last_error" json:"last_error"`
	CreatedAt  *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt  *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (UserMCPServer) TableName() string { return "user_mcp_servers" }
