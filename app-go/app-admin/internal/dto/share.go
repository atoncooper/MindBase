package dto

// ShareItem is one /api/shares row (list item + detail base); JSON matches the
// contract field list exactly.
type ShareItem struct {
	ID            int64  `json:"id"`
	TargetType    string `json:"targetType"`
	Name          string `json:"name"`
	OwnerUid      int64  `json:"ownerUid"`
	OwnerNickname string `json:"ownerNickname"`
	FileCount     int64  `json:"fileCount"`
	TotalSize     int64  `json:"totalSize"`
	HasCode       bool   `json:"hasCode"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
	ViewCount     int    `json:"viewCount"`
	DownloadCount int    `json:"downloadCount"`
	IsRevoked     bool   `json:"isRevoked"`
	// ContentAvailable — target file/folder still exists (live). Dead targets
	// stay visible for audit but are not part of the review queue.
	ContentAvailable bool   `json:"contentAvailable"`
	ContentReviewAck bool   `json:"contentReviewAck"`
	ModerationStatus string `json:"moderationStatus"`
	ModerationReason string `json:"moderationReason"`
	ModerationTime   string `json:"moderationTime,omitempty"`
	ModerationBy     string `json:"moderationBy,omitempty"`
	CreatedAt        string `json:"createdAt,omitempty"`
}

// FileMeta is one metadata entry in the share detail files list. Only
// name/size/mime/path plus the row id (the review plane's preview handle)
// ever leave the DB - no object keys, no content.
type FileMeta struct {
	ID       int64  `json:"fileId"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
	Path     string `json:"path"`
}

// PreviewGrant is the app-admin-only preview envelope returned by app-cloud's
// internal endpoint and passed through to the console: a short-lived INLINE
// presigned URL (pdf/image/audio/video) or extracted plain text for documents —
// never a download disposition and never an object-storage link for text.
type PreviewGrant struct {
	URL       string `json:"url"`
	ViewMode  string `json:"viewMode"`
	MimeType  string `json:"mimeType"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
	ExpiresIn int    `json:"expiresIn"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// ShareDetail adds the (capped) file metadata list to ShareItem.
type ShareDetail struct {
	ShareItem
	Files     []FileMeta `json:"files"`
	Truncated bool       `json:"truncated"`
}

// SharePage is the /api/shares list envelope.
type SharePage struct {
	Items    []ShareItem `json:"items"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}
