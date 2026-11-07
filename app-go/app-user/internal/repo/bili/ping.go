package repo

import (
	"context"

	"gorm.io/gorm"
)

// Ping is the readiness probe used by the HTTP health endpoint.
func Ping(ctx context.Context, db *gorm.DB) error {
	return db.WithContext(ctx).Exec("select 1").Error
}
