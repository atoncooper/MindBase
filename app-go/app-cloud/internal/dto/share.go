package dto

import "time"

// ── requests ────────────────────────────────────────────────────────

// ShareCreateRequest is the body of both owner share-create endpoints
// (file and folder). The two compliance acks are backend-enforced.
type ShareCreateRequest struct {
	Code             string `json:"code"`
	ExpiresInDays    int    `json:"expiresInDays"`
	MaxDownloads     *int   `json:"maxDownloads"`
	LegalAck         bool   `json:"legalAck"`
	ContentReviewAck bool   `json:"contentReviewAck"`
}

// ShareAttestRequest is the public device-attestation body.
type ShareAttestRequest struct {
	Challenge   string `json:"challenge"`
	Fingerprint string `json:"fingerprint"`
}

// ShareAccessRequest is the public share-access body. FileID selects one
// member for folder shares.
type ShareAccessRequest struct {
	Code     string `json:"code"`
	Download bool   `json:"download"`
	FileID   *int64 `json:"fileId"`
}

// ShareSetCodeRequest is the owner reset-code body.
type ShareSetCodeRequest struct {
	Code string `json:"code" binding:"required"`
}

// ── owner responses ─────────────────────────────────────────────────

// ShareView is the owner-facing share shape. Token fields are present for the
// owner list/create responses.
type ShareView struct {
	ID                         int64      `json:"id"`
	FileID                     int64      `json:"file_id"`
	HasCode                    bool       `json:"has_code"`
	ExtractionCode             string     `json:"extraction_code"`
	ExpiresAt                  *time.Time `json:"expires_at"`
	MaxDownloads               *int       `json:"max_downloads"`
	ViewCount                  int        `json:"view_count"`
	DownloadCount              int        `json:"download_count"`
	IsRevoked                  bool       `json:"is_revoked"`
	CreatedAt                  *time.Time `json:"created_at"`
	TargetType                 string     `json:"target_type"`
	FolderID                   *int64     `json:"folder_id"`
	LegalAck                   bool       `json:"legal_ack"`
	ContentReviewAck           bool       `json:"content_review_ack"`
	ContentReviewPolicyVersion *string    `json:"content_review_policy_version"`
	ContentReviewAckAt         *time.Time `json:"content_review_ack_at"`
	ModerationStatus           string     `json:"moderation_status"`
	ModerationReason           *string    `json:"moderation_reason"`
	ModerationTime             *time.Time `json:"moderation_time"`
	ModerationBy               *string    `json:"moderation_by"`
	ShareToken                 *string    `json:"share_token,omitempty"`
	ShareURL                   *string    `json:"share_url,omitempty"`
}

// ShareListResponse is the owner share list payload.
type ShareListResponse struct {
	Shares []ShareView `json:"shares"`
	Total  int         `json:"total"`
}

// ShareRevokeResponse is the DELETE /cloud/shares/{id} payload.
type ShareRevokeResponse struct {
	Revoked bool `json:"revoked"`
}

// ShareCodeResponse is the PATCH /cloud/shares/{id}/code payload.
type ShareCodeResponse struct {
	Updated bool `json:"updated"`
}

// ── public share responses ──────────────────────────────────────────

// SharePublicFile is one member file of a folder share.
type SharePublicFile struct {
	FileID   int64  `json:"fileId"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
	Path     string `json:"path"`
}

// ShareInfoResponse is the public GET /cloud/s/{token} payload. Target-specific
// fields are pointers so the file and folder shapes stay distinguishable.
type ShareInfoResponse struct {
	TargetType   string             `json:"targetType"`
	RequiresCode bool               `json:"requiresCode"`
	CreatedAt    *time.Time         `json:"createdAt"`
	ExpiresAt    *time.Time         `json:"expiresAt"`
	Challenge    string             `json:"challenge"`
	FolderName   *string            `json:"folderName,omitempty"`
	Files        *[]SharePublicFile `json:"files,omitempty"`
	Truncated    *bool              `json:"truncated,omitempty"`
	FileName     *string            `json:"fileName,omitempty"`
	FileSize     *int64             `json:"fileSize,omitempty"`
	MimeType     *string            `json:"mimeType,omitempty"`
}

// ShareAttestResponse is the public device-attestation payload.
type ShareAttestResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int    `json:"expiresIn"`
}

// ShareAccessResponse is the public presigned-access payload.
type ShareAccessResponse struct {
	URL       string `json:"url"`
	ViewMode  string `json:"viewMode"`
	MimeType  string `json:"mimeType"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
	ExpiresIn int    `json:"expiresIn"`
}

// AdminReviewAccessResponse is the app-admin review payload: an inline presigned
// grant for media, or a bounded plain-text rendition for documents.
type AdminReviewAccessResponse struct {
	URL       string `json:"url,omitempty"`
	ViewMode  string `json:"viewMode"`
	MimeType  string `json:"mimeType"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
	ExpiresIn int    `json:"expiresIn"`
	Text      string `json:"text,omitempty"`
	Truncated *bool  `json:"truncated,omitempty"`
}
