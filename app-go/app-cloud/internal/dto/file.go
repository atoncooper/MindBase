package dto

import (
	"encoding/json"
	"time"
)

// Video/list/search items keep the legacy snake_case keys plus the camelCase
// timestamps the Python-era contract exposed.

// VideoItem is one row of the file list / name search.
type VideoItem struct {
	UploadUUID   string     `json:"upload_uuid"`
	OriginalName string     `json:"original_name"`
	FileSize     int64      `json:"file_size"`
	MimeType     string     `json:"mime_type"`
	Duration     *int       `json:"duration"`
	AsrStatus    string     `json:"asr_status"`
	VectorStatus string     `json:"vector_status"`
	Title        *string    `json:"title"`
	CoverURL     *string    `json:"cover_url"`
	CreatedAt    *time.Time `json:"createdAt"`
}

// VideoListResponse is the GET /cloud/videos payload.
type VideoListResponse struct {
	Videos   []VideoItem `json:"videos"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
	HasMore  bool        `json:"hasMore"`
}

// VideoDetailResponse is the file detail payload (GET/PATCH /cloud/video/{uuid}).
type VideoDetailResponse struct {
	UploadUUID       string     `json:"upload_uuid"`
	OriginalName     string     `json:"original_name"`
	FileSize         int64      `json:"file_size"`
	MimeType         string     `json:"mime_type"`
	Duration         *int       `json:"duration"`
	AsrStatus        string     `json:"asr_status"`
	VectorStatus     string     `json:"vector_status"`
	Title            *string    `json:"title"`
	CoverURL         *string    `json:"cover_url"`
	CreatedAt        *time.Time `json:"created_at"`
	Description      *string    `json:"description"`
	Tags             []string   `json:"tags"`
	FolderID         *int64     `json:"folder_id"`
	FolderName       string     `json:"folderName"`
	AsrPreview       *string    `json:"asrPreview"`
	VectorChunkCount int        `json:"vector_chunk_count"`
}

// VideoUpdateRequest is the PATCH /cloud/video/{uuid} body. Absent fields keep
// their value; explicit null clears description/title/folder; a present tags
// array replaces the list. Presence and malformed values are tracked so the
// handler keeps the legacy 422 copy.
type VideoUpdateRequest struct {
	Title          *string
	TitleSet       bool
	Description    *string
	DescriptionSet bool
	Tags           []string
	TagsSet        bool
	TagsInvalid    bool
	FolderID       *int64
	FolderSet      bool
	FolderInvalid  bool
}

// UnmarshalJSON records which fields the caller actually sent.
func (r *VideoUpdateRequest) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["title"]; ok {
		r.TitleSet = true
		if !isJSONNull(v) {
			var title string
			if err := json.Unmarshal(v, &title); err != nil {
				return err
			}
			r.Title = &title
		}
	}
	if v, ok := raw["description"]; ok {
		r.DescriptionSet = true
		if !isJSONNull(v) {
			var desc string
			if err := json.Unmarshal(v, &desc); err != nil {
				return err
			}
			r.Description = &desc
		}
	}
	if v, ok := raw["tags"]; ok && !isJSONNull(v) {
		r.TagsSet = true
		var tags []string
		if err := json.Unmarshal(v, &tags); err != nil {
			r.TagsInvalid = true
		} else {
			r.Tags = tags
		}
	}
	if v, ok := raw["folderId"]; ok {
		r.FolderSet = true
		if !isJSONNull(v) {
			id, ok := parseJSONInt64(v)
			if !ok {
				r.FolderInvalid = true
			} else {
				r.FolderID = &id
			}
		}
	}
	return nil
}

// VideoDeleteResponse is the DELETE /cloud/video/{uuid} payload.
type VideoDeleteResponse struct {
	Deleted    bool   `json:"deleted"`
	UploadUUID string `json:"uploadUuid"`
}

// VideoProcessResponse is the POST /cloud/video/{uuid}/process payload.
type VideoProcessResponse struct {
	UploadUUID string `json:"uploadUuid"`
}

// VideoReprocessResponse is the POST /cloud/video/{uuid}/reprocess payload.
type VideoReprocessResponse struct {
	UploadUUID string `json:"uploadUuid"`
	TaskID     string `json:"taskId"`
}

// VideoStatusResponse is the GET /cloud/video/{uuid}/status payload.
type VideoStatusResponse struct {
	AsrStatus        string `json:"asr_status"`
	AsrProgress      int    `json:"asrProgress"`
	VectorStatus     string `json:"vector_status"`
	VectorChunkCount int    `json:"vectorChunkCount"`
}

// DocumentPreviewResponse is the GET /cloud/video/{uuid}/preview payload.
type DocumentPreviewResponse struct {
	UploadUUID   string         `json:"upload_uuid"`
	FileName     string         `json:"fileName"`
	MimeType     string         `json:"mime_type"`
	Vectorizable bool           `json:"vectorizable"`
	Preview      string         `json:"preview"`
	DocMeta      map[string]any `json:"docMeta"`
	Offset       int            `json:"offset"`
	Limit        int            `json:"limit"`
	TotalChars   int            `json:"totalChars"`
	HasMore      bool           `json:"hasMore"`
	NextOffset   *int           `json:"nextOffset"`
}

// RawFileResponse is the GET /cloud/video/{uuid}/raw payload (presigned URL,
// optionally with inline text content for text-like files).
type RawFileResponse struct {
	URL      string  `json:"url"`
	Content  *string `json:"content"`
	MimeType string  `json:"mimeType"`
	FileName string  `json:"fileName"`
	FileSize int64   `json:"fileSize"`
	ViewMode string  `json:"viewMode"`
}

// SearchFilesResponse is the GET /cloud/search payload (name search).
type SearchFilesResponse struct {
	Results []VideoItem `json:"results"`
	Total   int         `json:"total"`
}
