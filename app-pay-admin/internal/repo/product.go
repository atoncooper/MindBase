// Package repo: SKU catalog reads (pay_product, read-only in phase 1) +
// shared helpers.
package repo

import (
	"errors"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
	"gorm.io/gorm"
)

// ListProducts returns the SKU catalog ordered for display (sort ASC, then id).
func ListProducts() ([]model.PayProduct, error) {
	var ps []model.PayProduct
	err := db.DB.Order("sort ASC, id ASC").Find(&ps).Error
	if err != nil {
		return nil, err
	}
	return ps, nil
}

// isNotFound normalizes gorm's ErrRecordNotFound (used by the single-row getters).
func isNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
