package dto

import "time"

// SaveRefRequest is the POST /cloud/refs body.
type SaveRefRequest struct {
	Token          string `json:"token" binding:"required"`
	Code           string `json:"code"`
	TargetFolderID *int64 `json:"targetFolderId"`
}

// SaveRefResponse is the POST /cloud/refs payload. RootFolderID only appears
// for folder saves that mirrored a tree.
type SaveRefResponse struct {
	Saved        int    `json:"saved"`
	RootFolderID *int64 `json:"rootFolderId,omitempty"`
}

// RefItem is one saved reference row.
type RefItem struct {
	ID               int64      `json:"id"`
	Name             string     `json:"name"`
	Size             int64      `json:"size"`
	MimeType         string     `json:"mimeType"`
	FolderID         *int64     `json:"folderId"`
	Status           string     `json:"status"`
	ShareID          int64      `json:"shareId"`
	SourceUploadUUID string     `json:"sourceUploadUuid"`
	SourceName       string     `json:"sourceName"`
	CreatedAt        *time.Time `json:"createdAt"`
	IsRef            bool       `json:"isRef"`
}

// RefListResponse is the GET /cloud/refs payload.
type RefListResponse struct {
	Refs  []RefItem `json:"refs"`
	Total int64     `json:"total"`
}

// RefDeleteResponse is the DELETE /cloud/refs/{id} payload.
type RefDeleteResponse struct {
	Deleted bool `json:"deleted"`
}

// RefRawResponse is the GET /cloud/refs/{id}/raw payload (presigned grant
// through the original object).
type RefRawResponse struct {
	URL       string `json:"url"`
	ViewMode  string `json:"viewMode"`
	MimeType  string `json:"mimeType"`
	FileName  string `json:"fileName"`
	FileSize  int64  `json:"fileSize"`
	ExpiresIn int    `json:"expiresIn"`
}
