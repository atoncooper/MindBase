// Package settings defines the HTTP request DTOs for the settings domain
// (user preferences + Coding Plan). Routers bind these types; the service layer
// owns the business rules. The DTO layer must not import service, repo or
// router packages.
package settings

// PreferencesPatchRequest is PATCH /preferences. Values are arbitrary JSON
// and are re-encoded before persistence.
type PreferencesPatchRequest struct {
	Preferences map[string]any `json:"preferences"`
}

// ── Coding Plan (VIP/SVIP only) ──────────────────────────────────────

// CodingPlanCreateRequest is POST /settings/coding-plans. provider is
// opencode|kimi|custom; protocol is openai|anthropic; enabled defaults true.
type CodingPlanCreateRequest struct {
	Provider string `json:"provider" binding:"required"`
	Protocol string `json:"protocol" binding:"required"`
	Label    string `json:"label"`
	BaseURL  string `json:"base_url" binding:"required"`
	Model    string `json:"model" binding:"required"`
	APIKey   string `json:"api_key" binding:"required"`
	Enabled  *bool  `json:"enabled"`
}

// CodingPlanUpdateRequest is PATCH /settings/coding-plans/{id}; every field is
// optional and an empty api_key keeps the stored key.
type CodingPlanUpdateRequest struct {
	Provider *string `json:"provider"`
	Protocol *string `json:"protocol"`
	Label    *string `json:"label"`
	BaseURL  *string `json:"base_url"`
	Model    *string `json:"model"`
	APIKey   *string `json:"api_key"`
	Enabled  *bool   `json:"enabled"`
}
