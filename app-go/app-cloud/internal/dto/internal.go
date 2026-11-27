package dto

// InternalFolderItem is one row of the M2M folder listing
// (GET /internal/cloud/folders). parent_id is null for a root-level folder.
type InternalFolderItem struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	ParentID *int64 `json:"parent_id"`
}

// InternalFolderListResponse is the GET /internal/cloud/folders payload. One
// level of the tree per call: the caller passes parent_id to descend.
type InternalFolderListResponse struct {
	Items []InternalFolderItem `json:"items"`
}

// ReconcileResponse is the internal GET /internal/cloud/reconcile payload
// (per-user ledger vs object-storage drift report).
type ReconcileResponse struct {
	UID            int64    `json:"uid"`
	DBActiveBytes  int64    `json:"db_active_bytes"`
	DBActiveCount  int64    `json:"db_active_count"`
	DBTrashBytes   int64    `json:"db_trash_bytes"`
	MinioBytes     int64    `json:"minio_bytes"`
	MinioCount     int64    `json:"minio_count"`
	OrphanObjects  int      `json:"orphan_objects"`
	OrphanSample   []string `json:"orphan_sample"`
	MissingObjects int      `json:"missing_objects"`
	DriftBytes     int64    `json:"drift_bytes"`
}
