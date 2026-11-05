package dto

import "time"

// TrashItem is one soft-deleted file.
type TrashItem struct {
	UploadUUID   string     `json:"upload_uuid"`
	OriginalName string     `json:"original_name"`
	FileSize     int64      `json:"file_size"`
	MimeType     string     `json:"mime_type"`
	DeletedAt    *time.Time `json:"deleted_at"`
	PurgeAt      *time.Time `json:"purge_at"`
}

// TrashListResponse is the GET /cloud/trash payload.
type TrashListResponse struct {
	Items []TrashItem `json:"items"`
	Total int         `json:"total"`
}

// TrashRestoreResponse is the POST /cloud/trash/{uuid}/restore payload.
type TrashRestoreResponse struct {
	Restored   bool   `json:"restored"`
	UploadUUID string `json:"upload_uuid"`
}

// TrashPurgeResponse is the DELETE /cloud/trash/{uuid} payload.
type TrashPurgeResponse struct {
	Purged     bool   `json:"purged"`
	UploadUUID string `json:"upload_uuid"`
}

// EmptyTrashResponse is the DELETE /cloud/trash payload.
type EmptyTrashResponse struct {
	Purged int `json:"purged"`
}
