// Package model defines the GORM structs for the note tables (notes /
// note_anchors / note_shares). Columns mirror db/system.sql verbatim —
// the tables already exist with live data created by the Python backend.
package model

import "time"

// Note — MySQL metadata row; the markdown body lives in MongoDB
// (note_documents), keyed by UUID via ContentDocID.
type Note struct {
	ID            int       `gorm:"column:id;primaryKey;autoIncrement"`
	UUID          string    `gorm:"column:uuid"`
	UID           int64     `gorm:"column:uid"`
	Title         string    `gorm:"column:title"`
	TargetType    string    `gorm:"column:target_type"`
	TargetID      string    `gorm:"column:target_id"`
	ContentDocID  string    `gorm:"column:content_doc_id"`
	ContentLength int       `gorm:"column:content_length"`
	ContentHash   *string   `gorm:"column:content_hash"`
	RevisionCount int       `gorm:"column:revision_count"`
	IsPinned      bool      `gorm:"column:is_pinned"`
	IsDeleted     bool      `gorm:"column:is_deleted"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
	UpdatedAt     time.Time `gorm:"column:updated_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (Note) TableName() string { return "notes" }

// NoteAnchor — per-block bookmark inside a note.
type NoteAnchor struct {
	ID        int       `gorm:"column:id;primaryKey;autoIncrement"`
	NoteID    int       `gorm:"column:note_id"`
	BlockID   string    `gorm:"column:block_id"`
	Position  int       `gorm:"column:position"`
	Label     *string   `gorm:"column:label"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (NoteAnchor) TableName() string { return "note_anchors" }

// NoteShare — public share token; NULL expires_at = permanent.
type NoteShare struct {
	ID           int        `gorm:"column:id;primaryKey;autoIncrement"`
	NoteUUID     string     `gorm:"column:note_uuid"`
	ShareToken   string     `gorm:"column:share_token"`
	CreatedByUID int64      `gorm:"column:created_by_uid"`
	ExpiresAt    *time.Time `gorm:"column:expires_at"`
	ViewCount    int        `gorm:"column:view_count"`
	IsRevoked    bool       `gorm:"column:is_revoked"`
	CreatedAt    time.Time  `gorm:"column:created_at;autoCreateTime:false;autoUpdateTime:false"`
}

func (NoteShare) TableName() string { return "note_shares" }
