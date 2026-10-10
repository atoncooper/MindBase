// Package model defines the GORM structs for the acquisition tables
// (collection / favorite_folders / video / video_versions / async_tasks).
// Columns mirror the live schema — the tables already exist with live data
// created by the Python backend.
//
// RED LINE: the video struct carries the is_vectorized* / kg_* fields for
// read compatibility only — app-bili NEVER writes them (vectorization and
// KG stay in the Python AI stack; the guard is behavioral, enforced by the
// repo layer exposing no write path for those columns).
package model

import "time"

// Collection — one synced favorite video per (media_id, bvid).
type Collection struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	MediaID     int64     `gorm:"column:media_id"`
	BvID        string    `gorm:"column:bvid"`
	CID         *int64    `gorm:"column:cid"`
	Title       string    `gorm:"column:title"`
	Cover       *string   `gorm:"column:cover"`
	Duration    *int      `gorm:"column:duration"`
	OwnerName   *string   `gorm:"column:owner_name"`
	OwnerMid    *int64    `gorm:"column:owner_mid"`
	Description *string   `gorm:"column:description"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
	UpdatedAt   time.Time `gorm:"column:updated_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (Collection) TableName() string { return "collection" }

// FavoriteFolder — one synced favorite folder per (uid, media_id).
type FavoriteFolder struct {
	ID         int64      `gorm:"column:id;primaryKey;autoIncrement"`
	SessionID  *string    `gorm:"column:session_id"`
	MediaID    int64      `gorm:"column:media_id"`
	FID        *int64     `gorm:"column:fid"`
	Title      string     `gorm:"column:title"`
	MediaCount *int       `gorm:"column:media_count"`
	IsSelected *bool      `gorm:"column:is_selected"`
	LastSyncAt *time.Time `gorm:"column:last_sync_at;autoCreateTime:false;autoUpdateTime:false"`
	CreatedAt  time.Time  `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
	UpdatedAt  time.Time  `gorm:"column:updated_at;autoCreateTime:false;autoUpdateTime:false"`
	UID        *int64     `gorm:"column:uid"`
	IsDefault  *bool      `gorm:"column:is_default"`
	DeletedAt  *time.Time `gorm:"column:deleted_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (FavoriteFolder) TableName() string { return "favorite_folders" }

// Video — one page (cid) with ASR state. The vectorized/kg columns are
// read-only for app-bili (written by the Python AI stack).
type Video struct {
	ID            int64      `gorm:"column:id;primaryKey;autoIncrement"`
	BvID          string     `gorm:"column:bvid"`
	CID           int64      `gorm:"column:cid"`
	PageIndex     int        `gorm:"column:page_index"`
	PageTitle     *string    `gorm:"column:page_title"`
	ContentSource *string    `gorm:"column:content_source"`
	IsProcessed   *bool      `gorm:"column:is_processed"`
	Version       *int       `gorm:"column:version"`
	IsVectorized  *string    `gorm:"column:is_vectorized"`
	VectorizedAt  *time.Time `gorm:"column:vectorized_at;autoCreateTime:false;autoUpdateTime:false"`
	VectorChunks  *int       `gorm:"column:vector_chunk_count"`
	VectorError   *string    `gorm:"column:vector_error"`
	VectorAsrVer  *int       `gorm:"column:vector_asr_version"`
	KGStatus      *string    `gorm:"column:kg_status"`
	KGVersion     *int       `gorm:"column:kg_version"`
	CreatedAt     time.Time  `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
	UpdatedAt     time.Time  `gorm:"column:updated_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (Video) TableName() string { return "video" }

// VideoVersion — ASR version history per (bvid, cid).
type VideoVersion struct {
	ID            int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BvID          string    `gorm:"column:bvid"`
	CID           int64     `gorm:"column:cid"`
	PageIndex     int       `gorm:"column:page_index"`
	Version       int       `gorm:"column:version"`
	ContentSource *string   `gorm:"column:content_source"`
	IsLatest      *bool     `gorm:"column:is_latest"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (VideoVersion) TableName() string { return "video_versions" }

// AsyncTask — generic task state machine (build/asr rows owned by app-bili;
// vec_page rows are written by the Python AI stack on the shared table).
type AsyncTask struct {
	ID          int64      `gorm:"column:id;primaryKey;autoIncrement"`
	UID         *int64     `gorm:"column:uid"`
	TaskID      string     `gorm:"column:task_id"`
	TaskType    string     `gorm:"column:task_type"`
	Target      string     `gorm:"column:target"` // raw JSON
	Status      *string    `gorm:"column:status"`
	Progress    *int       `gorm:"column:progress"`
	Steps       *string    `gorm:"column:steps"`  // raw JSON
	Result      *string    `gorm:"column:result"` // raw JSON
	Error       *string    `gorm:"column:error"`
	CreatedAt   time.Time  `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
	UpdatedAt   time.Time  `gorm:"column:updated_at;autoCreateTime:false;autoUpdateTime:false"`
	CompletedAt *time.Time `gorm:"column:completed_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (AsyncTask) TableName() string { return "async_tasks" }
