package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// VerificationRepo — verification_codes access (email/sms one-time codes,
// MySQL-backed with per-code attempts counters).
type VerificationRepo struct{}

func NewVerificationRepo() *VerificationRepo { return &VerificationRepo{} }

// InvalidateOlder marks all previous unused codes for (target, purpose) as
// used — one live code per target/purpose at a time.
func (r *VerificationRepo) InvalidateOlder(db *gorm.DB, target, purpose string) error {
	return db.Model(&model.VerificationCode{}).
		Where("target = ? AND purpose = ? AND used = 0", target, purpose).
		Update("used", true).Error
}

// Create stores a fresh code (called after InvalidateOlder in one transaction
// by the service layer).
func (r *VerificationRepo) Create(db *gorm.DB, v *model.VerificationCode) error {
	now := time.Now()
	if v.CreatedAt == nil {
		v.CreatedAt = &now
	}
	return db.Create(v).Error
}

// Consume atomically validates + burns a code: matches (target, purpose,
// code, unused, unexpired) and flips used=1 in one UPDATE — the affected-rows
// count is the single source of truth (no read-then-write race).
func (r *VerificationRepo) Consume(db *gorm.DB, target, purpose, code string) (bool, error) {
	res := db.Model(&model.VerificationCode{}).
		Where("target = ? AND purpose = ? AND code = ? AND used = 0 AND expires_at > ?",
			target, purpose, code, time.Now()).
		Update("used", true)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// FindLatestUnused returns the most recent unused code for (target, purpose),
// or nil.
func (r *VerificationRepo) FindLatestUnused(db *gorm.DB, target, purpose string) (*model.VerificationCode, error) {
	var v model.VerificationCode
	err := db.Where("target = ? AND purpose = ? AND used = 0 AND expires_at > ?",
		target, purpose, time.Now()).
		Order("id DESC").First(&v).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

// MarkUsed burns a code by id (VerifyCode→ConsumeCode two-phase).
func (r *VerificationRepo) MarkUsed(db *gorm.DB, id int64) error {
	return db.Model(&model.VerificationCode{}).Where("id = ?", id).Update("used", true).Error
}

// FindLatestUnusedResetToken locates an unused, unexpired reset token.
func (r *VerificationRepo) FindLatestUnusedResetToken(db *gorm.DB, token string) (*model.VerificationCode, error) {
	var v model.VerificationCode
	err := db.Where("purpose = ? AND code = ? AND used = 0 AND expires_at > ?",
		"reset_password", token, time.Now()).
		Order("id DESC").First(&v).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

// MarkUsedResetToken burns every unused reset_password row for the token.
func (r *VerificationRepo) MarkUsedResetToken(db *gorm.DB, token string) error {
	return db.Model(&model.VerificationCode{}).
		Where("code = ? AND purpose = ?", token, "reset_password").
		Update("used", true).Error
}

// CountRecentByTarget counts codes created for target since a timestamp
// (per-target send cooldown).
func (r *VerificationRepo) CountRecentByTarget(db *gorm.DB, target string, since time.Time) (int64, error) {
	var n int64
	err := db.Model(&model.VerificationCode{}).
		Where("target = ? AND created_at >= ?", target, since).Count(&n).Error
	return n, err
}

// CountRecentByUID counts codes created by uid since a timestamp
// (per-uid send window).
func (r *VerificationRepo) CountRecentByUID(db *gorm.DB, uid int64, since time.Time) (int64, error) {
	var n int64
	err := db.Model(&model.VerificationCode{}).
		Where("uid = ? AND created_at >= ?", uid, since).Count(&n).Error
	return n, err
}

// BumpAttempts increments the wrong-code counter and returns the new value;
// the service layer burns the code once attempts exceed the configured cap.
func (r *VerificationRepo) BumpAttempts(db *gorm.DB, target, purpose, code string) (int, error) {
	res := db.Model(&model.VerificationCode{}).
		Where("target = ? AND purpose = ? AND code = ? AND used = 0", target, purpose, code).
		Update("attempts", gorm.Expr("attempts + 1"))
	if res.Error != nil {
		return 0, res.Error
	}
	if res.RowsAffected == 0 {
		return 0, nil
	}
	var v model.VerificationCode
	err := db.Where("target = ? AND purpose = ? AND code = ?", target, purpose, code).
		Order("id DESC").First(&v).Error
	if err != nil {
		return 0, err
	}
	if v.Attempts != nil {
		return *v.Attempts, nil
	}
	return 0, nil
}
