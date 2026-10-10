// Workspace models — RAG 工作区（绑定云盘文件夹/文件的检索范围）。wire 契约
// camelCase（Python FastAPI by_alias 遗产），与 app-cloud 其他 snake_case 端点不同。
package model

import "time"

// Workspace — one RAG scoping workspace per user.
type Workspace struct {
	ID          int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	UID         int64      `gorm:"column:uid" json:"uid"`
	Name        string     `gorm:"column:name" json:"name"`
	Description *string    `gorm:"column:description" json:"description"`
	Icon        *string    `gorm:"column:icon" json:"icon"`
	Color       *string    `gorm:"column:color" json:"color"`
	FileCount   int        `gorm:"column:file_count" json:"fileCount"`
	ChunkCount  int        `gorm:"column:chunk_count" json:"chunkCount"`
	CreatedAt   *time.Time `gorm:"column:created_at" json:"createdAt"`
	UpdatedAt   *time.Time `gorm:"column:updated_at" json:"updatedAt"`
	DeletedAt   *time.Time `gorm:"column:deleted_at" json:"-"`
}

func (Workspace) TableName() string { return "workspaces" }

// WorkspaceBinding — folder or single-file binding inside a workspace.
type WorkspaceBinding struct {
	ID                int64      `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	WorkspaceID       int64      `gorm:"column:workspace_id" json:"workspaceId"`
	UID               int64      `gorm:"column:uid" json:"uid"`
	BindType          string     `gorm:"column:bind_type" json:"bindType"`
	FolderID          *int64     `gorm:"column:folder_id" json:"folderId"`
	UploadUUID        *string    `gorm:"column:upload_uuid" json:"uploadUuid"`
	IncludeSubfolders bool       `gorm:"column:include_subfolders" json:"includeSubfolders"`
	CreatedAt         *time.Time `gorm:"column:created_at" json:"createdAt"`
}

func (WorkspaceBinding) TableName() string { return "workspace_bindings" }
