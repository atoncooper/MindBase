// Package model mirrors the cloud tables owned by app-cloud in the shared
// bilirag MySQL database. Column names/types MUST match the existing schema
// (app/system.sql + app/models.py) exactly — the tables already hold live
// data and the Python backend keeps READ access (notes/workspace/RAG).
package model

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// JSON column helpers (cloud_files.tags / doc_meta are MySQL JSON columns).

type JSON map[string]any

func (j JSON) Value() (driver.Value, error) { return json.Marshal(j) }

func (j *JSON) Scan(value any) error {
	switch v := value.(type) {
	case nil:
		*j = nil
		return nil
	case []byte:
		return json.Unmarshal(v, j)
	case string:
		return json.Unmarshal([]byte(v), j)
	default:
		return fmt.Errorf("unsupported JSON scan type %T", value)
	}
}

type StringList []string

func (s StringList) Value() (driver.Value, error) { return json.Marshal(s) }

func (s *StringList) Scan(value any) error {
	switch v := value.(type) {
	case nil:
		*s = nil
		return nil
	case []byte:
		return json.Unmarshal(v, s)
	case string:
		return json.Unmarshal([]byte(v), s)
	default:
		return errors.New("unsupported StringList scan type")
	}
}

// CloudFolder — user-defined folder tree (self-referencing parent_id).
type CloudFolder struct {
	ID         int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID        int64      `gorm:"column:uid" json:"uid"`
	ParentID   *int64     `gorm:"column:parent_id" json:"parent_id"`
	Name       string     `gorm:"column:name" json:"name"`
	VideoCount *int       `gorm:"column:video_count" json:"video_count"`
	SortOrder  *int       `gorm:"column:sort_order" json:"sort_order"`
	CreatedAt  *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt  *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt  *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (CloudFolder) TableName() string { return "cloud_folders" }

// CloudFile — one uploaded object. Status columns: upload_status, asr_status
// (pending/processing/done/failed), vector_status
// (pending/processing/done/failed/not_supported).
type CloudFile struct {
	ID               int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UploadUUID       string     `gorm:"column:upload_uuid;uniqueIndex" json:"upload_uuid"`
	UID              int64      `gorm:"column:uid" json:"uid"`
	FolderID         *int64     `gorm:"column:folder_id" json:"folder_id"`
	OriginalName     string     `gorm:"column:original_name" json:"original_name"`
	FileSize         int64      `gorm:"column:file_size" json:"file_size"`
	MimeType         string     `gorm:"column:mime_type" json:"mime_type"`
	Duration         *int       `gorm:"column:duration" json:"duration"`
	Bucket           string     `gorm:"column:bucket" json:"bucket"`
	ObjectKey        string     `gorm:"column:object_key" json:"object_key"`
	ETag             *string    `gorm:"column:etag" json:"etag"`
	UploadStatus     *string    `gorm:"column:upload_status" json:"upload_status"`
	AsrStatus        *string    `gorm:"column:asr_status" json:"asr_status"`
	VectorStatus     *string    `gorm:"column:vector_status" json:"vector_status"`
	VectorChunkCount *int       `gorm:"column:vector_chunk_count" json:"vector_chunk_count"`
	Title            *string    `gorm:"column:title" json:"title"`
	Description      *string    `gorm:"column:description" json:"description"`
	CoverURL         *string    `gorm:"column:cover_url" json:"cover_url"`
	Tags             StringList `gorm:"column:tags;type:json" json:"tags"`
	Vectorizable     bool       `gorm:"column:vectorizable" json:"vectorizable"`
	DocParser        *string    `gorm:"column:doc_parser" json:"doc_parser"`
	DocMeta          JSON       `gorm:"column:doc_meta;type:json" json:"doc_meta"`
	ContentHash      *string    `gorm:"column:content_hash" json:"content_hash"`
	CreatedAt        *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt        *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt        *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (CloudFile) TableName() string { return "cloud_files" }

// CloudShare — Baidu-style share link (new table, owned by app-cloud).
type CloudShare struct {
	ID             int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	ShareToken     string     `gorm:"column:share_token;uniqueIndex" json:"share_token"`
	UID            int64      `gorm:"column:uid" json:"uid"`
	FileID         int64      `gorm:"column:file_id" json:"file_id"`
	ExtractionCode *string    `gorm:"column:extraction_code" json:"extraction_code"`
	ExpiresAt      *time.Time `gorm:"column:expires_at" json:"expires_at"`
	MaxDownloads   *int       `gorm:"column:max_downloads" json:"max_downloads"`
	ViewCount      int        `gorm:"column:view_count" json:"view_count"`
	DownloadCount  int        `gorm:"column:download_count" json:"download_count"`
	IsRevoked      bool       `gorm:"column:is_revoked" json:"is_revoked"`
	CreatedAt      *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt      *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (CloudShare) TableName() string { return "cloud_shares" }
