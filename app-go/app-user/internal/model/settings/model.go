// Package model mirrors the settings tables owned by app-user in the shared
// bilirag MySQL database. Column names/types MUST match the existing schema
// exactly — the tables hold live data.
package model

import "time"

// CodingPlan — a user-supplied third-party coding plan endpoint used by the
// in-site code agent. api_key_enc holds AES-256-GCM ciphertext (never plaintext)
// and is never serialized (json:"-"). provider: opencode|kimi|custom;
// protocol: openai|anthropic.
//
// Ownership note: the table is part of the settings domain (user configuration,
// not identity), so it is created/owned by internal/infra/db/settings.
type CodingPlan struct {
	ID        int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID       int64      `gorm:"column:uid" json:"uid"`
	Provider  string     `gorm:"column:provider" json:"provider"`
	Protocol  string     `gorm:"column:protocol" json:"protocol"`
	Label     *string    `gorm:"column:label" json:"label"`
	BaseURL   string     `gorm:"column:base_url" json:"base_url"`
	Model     *string    `gorm:"column:model" json:"model"`
	APIKeyEnc string     `gorm:"column:api_key_enc" json:"-"`
	Enabled   *bool      `gorm:"column:enabled" json:"enabled"`
	CreatedAt *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (CodingPlan) TableName() string { return "coding_plans" }
