// Package repo: pay_product access over the SECOND connection (db.PayDB,
// app_pay schema owned by app-pay).
//
// pay_product is the AUTHORITATIVE SKU catalog: app-pay seeds it once via a
// Flyway migration (V11) and then only reads it, while app-admin owns the
// console CRUD implemented by service.PayProductService. All statements are
// GORM builder calls (no raw SQL); the only index that matters is
// uk_pay_product_code.
package repo

import (
	"errors"
	"strings"

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

// GetProductByID resolves one SKU by surrogate id (nil if absent).
func GetProductByID(id int64) (*model.PayProduct, error) {
	var p model.PayProduct
	err := db.PayDB.Where("id = ?", id).First(&p).Error
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// GetProductByCode resolves one SKU by its unique code (nil if absent).
func GetProductByCode(code string) (*model.PayProduct, error) {
	var p model.PayProduct
	err := db.PayDB.Where("code = ?", code).First(&p).Error
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// CreateProduct inserts one SKU row. The unique code constraint is the final
// guard against a concurrent duplicate; IsDuplicateKey normalizes that error.
func CreateProduct(p *model.PayProduct) error {
	return db.PayDB.Create(p).Error
}

// UpdateProduct rewrites the editable columns of one SKU row. Code and
// created_at are intentionally not part of the SET list (code is immutable).
// A map is used so zero values (sort=0) are not skipped.
func UpdateProduct(p *model.PayProduct) error {
	return db.PayDB.Model(&model.PayProduct{}).Where("id = ?", p.ID).Updates(map[string]any{
		"title":         p.Title,
		"duration_days": p.DurationDays,
		"price_cents":   p.PriceCents,
		"tier":          p.Tier,
		"status":        p.Status,
		"sort":          p.Sort,
		"updated_at":    p.UpdatedAt,
	}).Error
}

// DeleteProduct hard-deletes one SKU row (callers MUST check order references
// first: pay_order keeps sku_code as history, so a referenced row is disabled
// instead of deleted).
func DeleteProduct(id int64) (int64, error) {
	res := db.PayDB.Delete(&model.PayProduct{}, id)
	return res.RowsAffected, res.Error
}

// CountOrdersBySkuCode counts pay_order rows that reference a SKU code (the
// delete-safety probe; no dedicated index — admin-scale counts stay bounded).
func CountOrdersBySkuCode(skuCode string) (int64, error) {
	var n int64
	err := db.PayDB.Model(&model.PayOrder{}).Where("sku_code = ?", skuCode).Count(&n).Error
	return n, err
}

// CountProductsByStatus counts SKU rows in one status (last-active guard).
func CountProductsByStatus(status string) (int64, error) {
	var n int64
	err := db.PayDB.Model(&model.PayProduct{}).Where("status = ?", status).Count(&n).Error
	return n, err
}

// IsDuplicateKey reports whether err is a unique-constraint violation on
// either supported driver (MySQL production / SQLite tests).
func IsDuplicateKey(err error) bool {
	if err == nil || errors.Is(err, gorm.ErrRecordNotFound) {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate entry") ||
		strings.Contains(msg, "duplicate key") ||
		strings.Contains(msg, "unique constraint failed")
}

// isNotFound normalizes gorm's ErrRecordNotFound (used by the single-row
// pay-domain getters).
func isNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
