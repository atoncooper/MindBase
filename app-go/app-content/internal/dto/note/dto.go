// Package note defines the HTTP wire contract for the note domain: validated
// request DTOs and response DTOs. Routers map service views into these types;
// the DTO layer has no dependency on the service packages.
package note

// CreateRequest is POST /notes.
type CreateRequest struct {
	Title      string `json:"title" binding:"max=500"`
	TargetType string `json:"target_type" binding:"required,oneof=video cloud_file"`
	TargetID   string `json:"target_id" binding:"required,max=100"`
	ContentMD  string `json:"content_md" binding:"max=262144"`
}

// UpdateRequest is PATCH /notes/:uuid (optimistic lock via If-Match).
type UpdateRequest struct {
	Title     *string `json:"title" binding:"omitempty,max=500"`
	ContentMD *string `json:"content_md" binding:"omitempty,max=262144"`
	IsPinned  *bool   `json:"is_pinned"`
}

// AnchorRequest is POST /notes/:uuid/anchors.
type AnchorRequest struct {
	BlockID  string  `json:"block_id" binding:"required,min=1,max=50"`
	Position *int    `json:"position" binding:"required,min=0"`
	Label    *string `json:"label" binding:"omitempty,max=200"`
}

// ShareRequest is POST /notes/:uuid/share (body optional).
type ShareRequest struct {
	ExpiresInDays *int `json:"expires_in_days" binding:"omitempty,min=1,max=365"`
}

// ListQuery is GET /notes; Normalize applies the contract bounds.
type ListQuery struct {
	TargetType string
	TargetID   string
	Page       int
	PageSize   int
}

// Normalize applies target_type/target_id/page bounds.
func (q *ListQuery) Normalize() bool {
	if q.TargetType != "" && q.TargetType != "video" && q.TargetType != "cloud_file" {
		return false
	}
	if len(q.TargetID) > 100 {
		return false
	}
	if q.Page < 1 || q.Page > 1000000 || q.PageSize < 1 || q.PageSize > 100 {
		return false
	}
	return true
}

// ── Responses ────────────────────────────────────────────────────────

// Meta is the note list item response.
type Meta struct {
	UUID          string `json:"uuid"`
	Title         string `json:"title"`
	TargetType    string `json:"target_type"`
	TargetID      string `json:"target_id"`
	ContentLength int    `json:"content_length"`
	IsPinned      bool   `json:"is_pinned"`
	RevisionCount int    `json:"revision_count"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// Anchor is one note anchor.
type Anchor struct {
	ID        int     `json:"id"`
	BlockID   string  `json:"block_id"`
	Position  int     `json:"position"`
	Label     *string `json:"label"`
	CreatedAt string  `json:"created_at"`
}

// Detail is the note detail response.
type Detail struct {
	Meta
	ContentMD      string   `json:"content_md"`
	Anchors        []Anchor `json:"anchors"`
	ShareToken     *string  `json:"share_token"`
	ShareExpiresAt *string  `json:"share_expires_at"`
}

// Share is the share-create response.
type Share struct {
	ShareToken string  `json:"share_token"`
	ShareURL   string  `json:"share_url"`
	ExpiresAt  *string `json:"expires_at"`
}

// Revision is the revision list item.
type Revision struct {
	RevisionID   string  `json:"revision_id"`
	RevisionNote *string `json:"revision_note"`
	CreatedAt    string  `json:"created_at"`
}

// Shared is the public shared-note response.
type Shared struct {
	Title      string `json:"title"`
	ContentMD  string `json:"content_md"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	SharedAt   string `json:"shared_at"`
	ViewCount  int    `json:"view_count"`
}
