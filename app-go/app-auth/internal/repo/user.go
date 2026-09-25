package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// UserRepo — users + user_profile access.
type UserRepo struct{}

func NewUserRepo() *UserRepo { return &UserRepo{} }

func (r *UserRepo) GetByUID(db *gorm.DB, uid int64) (*model.User, error) {
	var u model.User
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// GetByEmail / GetByEmailIncludingDeleted — lookups for login and register.
// Login must not reveal whether a soft-deleted account exists; register must
// refuse to reuse a deleted account's email (parity with the Python side).
func (r *UserRepo) GetByEmail(db *gorm.DB, email string) (*model.User, error) {
	return r.getBy(db, "email", email)
}

func (r *UserRepo) GetByPhone(db *gorm.DB, phone string) (*model.User, error) {
	return r.getBy(db, "phone", phone)
}

func (r *UserRepo) getBy(db *gorm.DB, col, val string) (*model.User, error) {
	var u model.User
	err := db.Where(col+" = ? AND deleted_at IS NULL", val).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// EmailExistsIncludingDeleted guards the unique index on register.
func (r *UserRepo) EmailExistsIncludingDeleted(db *gorm.DB, email string) (bool, error) {
	return r.exists(db, "email", email)
}

func (r *UserRepo) PhoneExistsIncludingDeleted(db *gorm.DB, phone string) (bool, error) {
	return r.exists(db, "phone", phone)
}

func (r *UserRepo) exists(db *gorm.DB, col, val string) (bool, error) {
	var n int64
	err := db.Model(&model.User{}).Where(col+" = ?", val).Count(&n).Error
	return n > 0, err
}

// Create inserts a user + empty profile in one transaction.
func (r *UserRepo) Create(db *gorm.DB, u *model.User, p *model.UserProfile) error {
	return db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		if u.CreatedAt == nil {
			u.CreatedAt = &now
		}
		if u.UpdatedAt == nil {
			u.UpdatedAt = &now
		}
		if err := tx.Create(u).Error; err != nil {
			return err
		}
		if p != nil {
			if p.CreatedAt == nil {
				p.CreatedAt = &now
			}
			if p.UpdatedAt == nil {
				p.UpdatedAt = &now
			}
			if err := tx.Create(p).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// UpdateProfileFields patches mutable profile columns on user_profile
// (upserting the row when absent) and refreshes users.updated_at.
func (r *UserRepo) UpdateProfileFields(db *gorm.DB, uid int64, fields map[string]any) error {
	now := time.Now()
	return db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.UserProfile{}).Where("uid = ?", uid).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			row := model.UserProfile{UID: uid}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		fields["updated_at"] = now
		return tx.Model(&model.UserProfile{}).Where("uid = ?", uid).Updates(fields).Error
	})
}

func (r *UserRepo) GetProfile(db *gorm.DB, uid int64) (*model.UserProfile, error) {
	var p model.UserProfile
	err := db.Where("uid = ?", uid).First(&p).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// SetUserFields patches columns on users (password_hash, verified flags,
// email/phone binding, status).
func (r *UserRepo) SetUserFields(db *gorm.DB, uid int64, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return db.Model(&model.User{}).Where("uid = ?", uid).Updates(fields).Error
}
