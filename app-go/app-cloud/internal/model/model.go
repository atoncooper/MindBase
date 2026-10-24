// Package model mirrors the cloud tables owned by app-cloud in the shared
// bilirag MySQL database. Column names/types MUST match the existing schema
// (db/system.sql + app/models.py) exactly — the tables already hold live
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

// Target types for CloudShare. Legacy rows (pre-1.0.16) read back as
// target_type='file' via the column DEFAULT share; empty string is treated
// as "file" everywhere (see service.IsFolderShare).
const (
	ShareTargetFile   = "file"
	ShareTargetFolder = "folder"
)

// Moderation status values (plan/1.0.16 §3.1 — written only by app-admin,
// read here so banned shares resolve uniformly as 404).
const (
	ModerationActive   = "active"
	ModerationApproved = "approved"
	ModerationBanned   = "banned"
)

// CloudShare — Baidu-style share link (new table, owned by app-cloud).
// The 1.0.16 share-contract, moderation, and content-review disclosure columns
// are applied by the idempotent ALTER set in internal/infra/db (pinned by that
// package's guard test) and mirrored in the CREATE-TABLE DDL verbatim.
type CloudShare struct {
	ID             int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	ShareToken     string     `gorm:"column:share_token;uniqueIndex" json:"share_token"`
	UID            int64      `gorm:"column:uid" json:"uid"`
	FileID         int64      `gorm:"column:file_id" json:"file_id"` // 0 for folder shares
	ExtractionCode *string    `gorm:"column:extraction_code" json:"extraction_code"`
	ExpiresAt      *time.Time `gorm:"column:expires_at" json:"expires_at"`
	MaxDownloads   *int       `gorm:"column:max_downloads" json:"max_downloads"`
	ViewCount      int        `gorm:"column:view_count" json:"view_count"`
	DownloadCount  int        `gorm:"column:download_count" json:"download_count"`
	IsRevoked      bool       `gorm:"column:is_revoked" json:"is_revoked"`
	// ── share-moderation companion columns (idempotent ALTER, 1.0.16) ──
	TargetType                 string     `gorm:"column:target_type" json:"target_type"` // 'file' | 'folder'
	FolderID                   *int64     `gorm:"column:folder_id" json:"folder_id"`     // set when TargetType=folder
	LegalAck                   bool       `gorm:"column:legal_ack" json:"legal_ack"`     // compliance warning confirmed
	ContentReviewAck           bool       `gorm:"column:content_review_ack" json:"content_review_ack"`
	ContentReviewPolicyVersion *string    `gorm:"column:content_review_policy_version" json:"content_review_policy_version"`
	ContentReviewAckAt         *time.Time `gorm:"column:content_review_ack_at" json:"content_review_ack_at"`
	ModerationStatus           string     `gorm:"column:moderation_status" json:"moderation_status"` // active/approved/banned
	ModerationReason           *string    `gorm:"column:moderation_reason" json:"moderation_reason"`
	ModerationTime             *time.Time `gorm:"column:moderation_time" json:"moderation_time"`
	ModerationBy               *string    `gorm:"column:moderation_by" json:"moderation_by"`
	CreatedAt                  *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt                  *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (CloudShare) TableName() string { return "cloud_shares" }

// IsFolderShare reports whether the share targets a folder. Legacy rows may
// carry an empty target_type (column added later with a 'file' default).
func (s CloudShare) IsFolderShare() bool { return s.TargetType == ShareTargetFolder }

// CloudRef — "save to my drive" reference row (new table, owned by
// app-cloud). A ref never copies the MinIO object and never counts toward
// quota: preview/download re-resolves the ORIGINAL object and flips the row
// to status='dead' the moment the source side (file deleted / share revoked
// or banned / share expired) no longer validates (plan/1.0.16 §3.2).
type CloudRef struct {
	ID               int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID              int64      `gorm:"column:uid" json:"uid"` // ref owner (saver)
	ShareID          int64      `gorm:"column:share_id" json:"share_id"`
	SourceFileID     int64      `gorm:"column:source_file_id" json:"source_file_id"`
	SourceUID        int64      `gorm:"column:source_uid" json:"source_uid"`
	SourceUploadUUID string     `gorm:"column:source_upload_uuid" json:"source_upload_uuid"`
	Name             string     `gorm:"column:name" json:"name"` // snapshot name at save time
	FileSize         int64      `gorm:"column:file_size" json:"file_size"`
	MimeType         string     `gorm:"column:mime_type" json:"mime_type"`
	FolderID         *int64     `gorm:"column:folder_id" json:"folder_id"` // saver's cloud_folders.id (nil = root)
	Status           string     `gorm:"column:status" json:"status"`       // 'alive' | 'dead'
	CreatedAt        *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt        *time.Time `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt        *time.Time `gorm:"column:deleted_at" json:"deleted_at"`
}

func (CloudRef) TableName() string { return "cloud_refs" }

// CloudVectorTask — durable outbox row for the vectorize pipeline (new table,
// owned by app-cloud; multi-replica hardening step ②). One row per
// upload_uuid; status mirrors the cloud_files.vector_status transition
// (pending → processing → done/failed). Workers claim with FOR UPDATE SKIP
// LOCKED (repo.ClaimNext) and a janitor requeues claims older than
// ChunkRow — one vectorized chunk handed from the pipeline to the vector
// store (shared vocabulary: pipeline builds it, milvusstore persists it).
type ChunkRow struct {
	ChunkIndex   int
	ChunkID      string
	Title        string
	Source       string
	SourceType   string
	SectionTitle string
	ContentType  string
	Text         string // embedding_text (what the model saw)
	Vector       []float32
}

// staleProcessingAfter — see service/workerpool.go.
type CloudVectorTask struct {
	ID         int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UploadUUID string     `gorm:"column:upload_uuid;uniqueIndex" json:"upload_uuid"`
	UID        int64      `gorm:"column:uid" json:"uid"`
	Status     string     `gorm:"column:status" json:"status"`
	Attempts   int        `gorm:"column:attempts" json:"attempts"`
	LastError  *string    `gorm:"column:last_error" json:"last_error"`
	ClaimedBy  *string    `gorm:"column:claimed_by" json:"claimed_by"`
	ClaimedAt  *time.Time `gorm:"column:claimed_at" json:"claimed_at"`
	CreatedAt  *time.Time `gorm:"column:created_at" json:"created_at"`
	UpdatedAt  *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (CloudVectorTask) TableName() string { return "cloud_vector_tasks" }
