package dto

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
