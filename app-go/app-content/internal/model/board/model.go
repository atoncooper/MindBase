// Package model defines the GORM models for app-board's schema.
//
// app-board owns the `board` table (created via db.Migrate at startup) inside
// the main app's MySQL database. The board BODY (simple-mind-map JSON or
// Excalidraw scene JSON) lives in MongoDB `board_documents` — MySQL keeps
// metadata only, mirroring the notes split-storage design.
package model

import (
	"time"
)

// Board is a mind-map or whiteboard document (kind distinguishes them).
// version is the optimistic-lock counter: bumped on every content update;
// clients send it back via If-Match (conflict -> 409, missing -> 428).
// deleted is a soft-delete flag; the Mongo body is kept for recovery.
type Board struct {
	UUID      string    `gorm:"column:uuid;primaryKey;size:36" json:"uuid"`
	UID       int64     `gorm:"column:uid;not null;index:idx_board_uid_updated,priority:1;index:idx_board_uid_kind,priority:1" json:"uid"`
	Title     string    `gorm:"column:title;size:255;not null;default:''" json:"title"`
	Kind      string    `gorm:"column:kind;size:16;not null;index:idx_board_uid_kind,priority:2" json:"kind"` // mindmap | whiteboard
	Version   int64     `gorm:"column:version;not null;default:1" json:"version"`
	IsPinned  bool      `gorm:"column:is_pinned;not null;default:false;index:idx_board_uid_updated,priority:2" json:"is_pinned"`
	Deleted   bool      `gorm:"column:deleted;not null;default:false;index:idx_board_uid_updated,priority:3" json:"deleted"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Board) TableName() string { return "board" }
