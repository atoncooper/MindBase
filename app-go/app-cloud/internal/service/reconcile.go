package service

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/minio"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// Reconciler — drift detection between the DB ledger (cloud_files) and the
// MinIO object store, WITHOUT a full-bucket scan.
//
// Why this exists: the DB is the accounting authority (every complete/purge
// transaction lands there), but two rare paths can drift it from physical
// reality:
//   - complete_upload MinIO success + DB write failure (logged critical,
//     requires manual fix) → object without a row
//   - crash between MinIO purge and DB hard delete → row without an object
//
// Reconciliation is per-user: MinIO ListObjectsV2 with a `{uid}/` prefix is
// a server-side efficient listing bounded to that user — never a bucket-wide
// walk. Drift is reported loudly (and in the report payload); the DB stays
// authoritative for quota, and orphan objects are surfaced for cleanup by
// the purge flow rather than silently auto-deleted.
type Reconciler struct {
	db    *gorm.DB
	minio *minio.Client
	files *repo.FileRepo
}

func NewReconciler(db *gorm.DB, mc *minio.Client) *Reconciler {
	return &Reconciler{db: db, minio: mc, files: repo.NewFileRepo()}
}

// ReconcileReport is the per-user outcome.
type ReconcileReport struct {
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

// ReconcileUser compares one user's DB ledger against their MinIO prefix.
func (r *Reconciler) ReconcileUser(ctx context.Context, uid int64) (*ReconcileReport, error) {
	rep := &ReconcileReport{UID: uid}

	// DB side: active + trash rows keyed by object_key.
	type row struct {
		ObjectKey string
		FileSize  int64
		Deleted   bool
	}
	var rows []row
	if err := r.db.Table("cloud_files").
		Select("object_key, file_size, deleted_at IS NOT NULL as deleted").
		Where("uid = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	dbKeys := make(map[string]row, len(rows))
	for _, x := range rows {
		if x.Deleted {
			rep.DBTrashBytes += x.FileSize
		} else {
			rep.DBActiveBytes += x.FileSize
			rep.DBActiveCount++
		}
		dbKeys[x.ObjectKey] = x
	}

	// MinIO side: per-user prefix listing (server-side efficient).
	prefix := itoa64(uid) + "/"
	for obj := range r.minio.ListPrefix(ctx, prefix) {
		rep.MinioBytes += obj.Size
		rep.MinioCount++
		if _, ok := dbKeys[obj.Key]; !ok {
			rep.OrphanObjects++
			if len(rep.OrphanSample) < 10 {
				rep.OrphanSample = append(rep.OrphanSample, obj.Key)
			}
		}
	}
	// DB row without an object (purge partial failure).
	for key := range dbKeys {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if !r.minio.Exists(ctx, key) {
			rep.MissingObjects++
		}
	}
	rep.DriftBytes = rep.MinioBytes - rep.DBActiveBytes - rep.DBTrashBytes
	return rep, nil
}

// ActiveUsers returns uids with recent drive activity (uploads/deletes),
// bounded — the rotating candidate set for background reconciliation.
func (r *Reconciler) ActiveUsers(ctx context.Context, since time.Time, limit int) ([]int64, error) {
	var uids []int64
	err := r.db.Raw(
		"SELECT DISTINCT uid FROM cloud_files WHERE COALESCE(updated_at, created_at) >= ? LIMIT ?",
		since, limit).Scan(&uids).Error
	return uids, err
}

// ReconcileActiveUsers reconciles users active in the last `days` days,
// bounded by maxUsers — the background sweep entry point.
func (r *Reconciler) ReconcileActiveUsers(ctx context.Context, days int, maxUsers int) int {
	since := time.Now().AddDate(0, 0, -days)
	uids, err := r.ActiveUsers(ctx, since, maxUsers)
	if err != nil {
		slog.Warn("[RECONCILE] candidate query failed", "err", err)
		return 0
	}
	for _, uid := range uids {
		rep, err := r.ReconcileUser(ctx, uid)
		if err != nil {
			slog.Warn("[RECONCILE] user reconcile failed", "uid", uid, "err", err)
			continue
		}
		if rep.OrphanObjects > 0 || rep.MissingObjects > 0 || rep.DriftBytes != 0 {
			slog.Warn("[RECONCILE] drift detected",
				"uid", rep.UID,
				"db_active", rep.DBActiveBytes,
				"db_trash", rep.DBTrashBytes,
				"minio", rep.MinioBytes,
				"orphans", rep.OrphanObjects,
				"missing", rep.MissingObjects,
				"sample", rep.OrphanSample)
		}
	}
	return len(uids)
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for v > 0 {
		pos--
		buf[pos] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[pos:])
}
