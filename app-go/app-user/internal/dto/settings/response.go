// Typed HTTP response contracts for the settings domain.
package settings

import "time"

// Message is the shared {"message": ...} success envelope (DELETE responses).
type Message struct {
	Message string `json:"message"`
}

// Preferences is GET/PATCH /preferences (decoded JSON values).
type Preferences struct {
	Preferences map[string]any `json:"preferences"`
}

// AvatarUpload is POST /avatar/upload.
type AvatarUpload struct {
	URL string `json:"url"`
}

// ── Coding Plan (VIP/SVIP only) ──────────────────────────────────────

// CodingPlan is the safe wire shape — api_key is never present, only masked.
type CodingPlan struct {
	ID           int64      `json:"id"`
	Provider     string     `json:"provider"`
	Protocol     string     `json:"protocol"`
	Label        string     `json:"label"`
	BaseURL      string     `json:"base_url"`
	Model        string     `json:"model"`
	APIKeyMasked string     `json:"api_key_masked"`
	Enabled      bool       `json:"enabled"`
	CreatedAt    *time.Time `json:"created_at"`
	UpdatedAt    *time.Time `json:"updated_at"`
}

// CodingPlans is GET /settings/coding-plans.
type CodingPlans struct {
	Plans []CodingPlan `json:"plans"`
}

// CodingPlanEnvelope is the POST/PATCH response ({plan:{...}}).
type CodingPlanEnvelope struct {
	Plan CodingPlan `json:"plan"`
}

// CodingPlanTestResponse is POST /settings/coding-plans/{id}/test.
type CodingPlanTestResponse struct {
	OK      bool     `json:"ok"`
	Message string   `json:"message"`
	Models  []string `json:"models,omitempty"`
}

// CodingPlanModels is GET /settings/coding-plans/{id}/models — the provider
// model catalog used by the chat dialog (probed on demand, not at save time).
type CodingPlanModels struct {
	PlanID   int64    `json:"plan_id"`
	Provider string   `json:"provider"`
	Protocol string   `json:"protocol"`
	Models   []string `json:"models"`
}

// InternalCodingPlan is GET /internal/settings/coding-plan/{uid} — the ONLY
// face that carries the decrypted api_key (M2M key-auth guarded).
type InternalCodingPlan struct {
	ID       int64  `json:"id"`
	Provider string `json:"provider"`
	Protocol string `json:"protocol"`
	Label    string `json:"label"`
	BaseURL  string `json:"base_url"`
	Model    string `json:"model"`
	APIKey   string `json:"api_key"`
}

// InternalCodingPlanEnvelope is the internal response ({plan:{...}}).
type InternalCodingPlanEnvelope struct {
	Plan InternalCodingPlan `json:"plan"`
}

// NewCodingPlanView converts decrypted plan fields into the safe wire shape.
// The plaintext api_key is masked here and never stored on the DTO.
func NewCodingPlanView(id int64, provider, protocol, label, baseURL, model, apiKey string, enabled bool, createdAt, updatedAt *time.Time) CodingPlan {
	return CodingPlan{
		ID:           id,
		Provider:     provider,
		Protocol:     protocol,
		Label:        label,
		BaseURL:      baseURL,
		Model:        model,
		APIKeyMasked: MaskCodingPlanKey(apiKey),
		Enabled:      enabled,
		CreatedAt:    createdAt,
		UpdatedAt:    updatedAt,
	}
}

// MaskCodingPlanKey masks a plaintext API key for the user-facing response DTO. The
// middle is never echoed; short keys collapse to a fixed mask.
func MaskCodingPlanKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "****"
	}
	return key[:3] + "****" + key[len(key)-4:]
}
