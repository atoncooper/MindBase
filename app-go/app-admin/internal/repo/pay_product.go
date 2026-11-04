// Package repo: SKU catalog reads (pay_product, read-only) + the shared
// not-found normalizer for the pay-domain getters.
package repo

import (
	"errors"

	"app-admin/internal/db"
	"app-admin/internal/model"

	"gorm.io/gorm"
)

// ListProducts returns the SKU catalog ordered for display (sort ASC, then id).
func ListProducts() ([]model.PayProduct, error) {
	var ps []model.PayProduct
	err := db.PayDB.Order("sort ASC, id ASC").Find(&ps).Error
	if err != nil {
		return nil, err
	}
	return ps, nil
}

// isNotFound normalizes gorm's ErrRecordNotFound (used by the single-row
// pay-domain getters).
func isNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
