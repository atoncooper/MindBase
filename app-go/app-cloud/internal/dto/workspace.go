package dto

// Workspace endpoints keep the Python-era camelCase wire contract.

// WorkspaceCreateRequest is the POST /workspaces body.
type WorkspaceCreateRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Icon        *string `json:"icon"`
	Color       *string `json:"color"`
}

// WorkspaceUpdateRequest is the PATCH /workspaces/{id} body.
type WorkspaceUpdateRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Icon        *string `json:"icon"`
	Color       *string `json:"color"`
}

// WorkspaceBindingRequest is the POST /workspaces/{id}/bindings body.
type WorkspaceBindingRequest struct {
	BindType          string  `json:"bindType"`
	FolderID          *int64  `json:"folderId"`
	UploadUUID        *string `json:"uploadUuid"`
	IncludeSubfolders *bool   `json:"includeSubfolders"`
}

// WorkspaceBinding is one binding row.
type WorkspaceBinding struct {
	ID                int64   `json:"id"`
	BindType          string  `json:"bindType"`
	FolderID          *int64  `json:"folderId"`
	FolderName        *string `json:"folderName"`
	UploadUUID        *string `json:"uploadUuid"`
	FileName          *string `json:"fileName"`
	IncludeSubfolders bool    `json:"includeSubfolders"`
}

// Workspace is one workspace with its bindings.
type Workspace struct {
	ID          int64              `json:"id"`
	Name        string             `json:"name"`
	Description *string            `json:"description"`
	Icon        *string            `json:"icon"`
	Color       *string            `json:"color"`
	FileCount   int                `json:"fileCount"`
	ChunkCount  int                `json:"chunkCount"`
	Bindings    []WorkspaceBinding `json:"bindings"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
}

// WorkspaceDeleteResponse is the DELETE /workspaces/{id} payload.
type WorkspaceDeleteResponse struct {
	Deleted bool `json:"deleted"`
}

// WorkspaceFileItem is one expanded file of a workspace.
type WorkspaceFileItem struct {
	UploadUUID       string `json:"uploadUuid"`
	OriginalName     string `json:"originalName"`
	MimeType         string `json:"mimeType"`
	Vectorizable     bool   `json:"vectorizable"`
	VectorStatus     string `json:"vectorStatus"`
	VectorChunkCount int    `json:"vectorChunkCount"`
}
