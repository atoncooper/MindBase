// Console account management: create / list / reset password /
// delete the admin_user accounts that gate the console itself.
//
// This module is INDEPENDENT of the payment database — it keeps working when
// app_pay is disabled. Business rules pinned here:
//   - an admin can never delete their own account;
//   - an admin can never delete the LAST admin (the console would lock itself out);
//   - resetting a password forces must_change_password=true AND deletes every
//     session of that account (a stolen cookie must not survive the reset);
//   - every mutation writes an admin_audit row (same database, so an audit
//     failure surfaces instead of silently leaving an untraceable change).
package service

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"app-admin/internal/dto"
	"app-admin/internal/repo"
)

// Account-management validation / rule errors (the router maps each onto its
// contract status code: 400 validation, 409 duplicate, 404 missing).
var (
	ErrConsoleInvalidUsername = errors.New("username must be 2..64 characters")
	ErrConsoleInvalidPassword = errors.New("password must be 8..128 characters")
	ErrConsolePasswordTooLong = errors.New("password must be at most 72 bytes (bcrypt limit)")
	ErrConsoleInvalidRole     = errors.New("role must be admin or viewer")
	ErrCannotDeleteSelf       = errors.New("cannot delete your own account")
	ErrLastAdmin              = errors.New("cannot delete the last admin")
)

// ConsoleUserService owns the account-management rules.
type ConsoleUserService struct {
	record AuditRecorder
}

// NewConsoleUserService wires the production admin_audit recorder.
func NewConsoleUserService() *ConsoleUserService {
	return &ConsoleUserService{record: repo.RecordAudit}
}

// NewConsoleUserServiceWithAudit is the test seam.
func NewConsoleUserServiceWithAudit(record AuditRecorder) *ConsoleUserService {
	return &ConsoleUserService{record: record}
}

// List returns every console account, username ASC (contract ordering).
func (s *ConsoleUserService) List() (*dto.ConsoleUserList, error) {
	rows, err := repo.ListAdminUsers()
	if err != nil {
		return nil, err
	}
	items := make([]dto.ConsoleUserItem, 0, len(rows))
	for i := range rows {
		items = append(items, dto.ConsoleUserItem{
			ID:                 rows[i].ID,
			Username:           rows[i].Username,
			Role:               rows[i].Role,
			MustChangePassword: rows[i].MustChangePassword,
			LastLoginAt:        rfc3339Ptr(rows[i].LastLoginAt),
			CreatedAt:          rfc3339Ptr(rows[i].CreatedAt),
		})
	}
	return &dto.ConsoleUserList{Items: items}, nil
}

// Create inserts one console account (role defaults to viewer). actor is the
// authenticated admin performing the change — it is the audit ledger's
// admin_name, NOT the new account's username.
func (s *ConsoleUserService) Create(actor, username, password, role string) (*dto.ConsoleUserCreated, error) {
	username, err := validateConsoleUsername(username)
	if err != nil {
		return nil, err
	}
	if err := validateConsolePassword(password); err != nil {
		return nil, err
	}
	if role == "" {
		role = repo.RoleViewer
	}
	if role != repo.RoleAdmin && role != repo.RoleViewer {
		return nil, ErrConsoleInvalidRole
	}
	u, err := repo.CreateAdminUser(username, password, role)
	if err != nil {
		return nil, err // repo.ErrUserExists -> 409
	}
	if err := s.audit(actor, "account_create", "admin_user",
		fmt.Sprintf("%d", u.ID), fmt.Sprintf("username=%s role=%s", u.Username, u.Role)); err != nil {
		return nil, err
	}
	return &dto.ConsoleUserCreated{ID: u.ID, Username: u.Username, Role: u.Role}, nil
}

// ResetPassword sets a new password, forces a change on next login and drops
// every session of that account. actor is the acting admin (audit ledger).
func (s *ConsoleUserService) ResetPassword(actor string, id int64, password string) error {
	if err := validateConsolePassword(password); err != nil {
		return err
	}
	target, err := repo.GetUserByID(id)
	if err != nil {
		return err
	}
	if target == nil {
		return repo.ErrUserNotFound
	}
	if err := repo.ResetUserPassword(id, password); err != nil {
		return err
	}
	if err := repo.DeleteUserSessions(id); err != nil {
		return err
	}
	return s.audit(actor, "account_password_reset", "admin_user",
		fmt.Sprintf("%d", id), fmt.Sprintf("username=%s", target.Username))
}

// Delete removes one console account (and its sessions). actorID / actor are
// the authenticated caller: self-deletion and last-admin deletion are refused,
// and the audit ledger records the acting admin (not the deleted account).
func (s *ConsoleUserService) Delete(actorID int64, actor string, id int64) error {
	if actorID == id {
		return ErrCannotDeleteSelf
	}
	target, err := repo.GetUserByID(id)
	if err != nil {
		return err
	}
	if target == nil {
		return repo.ErrUserNotFound
	}
	if target.Role == repo.RoleAdmin {
		admins, err := repo.CountAdminUsersByRole(repo.RoleAdmin)
		if err != nil {
			return err
		}
		if admins <= 1 {
			return ErrLastAdmin
		}
	}
	if err := repo.DeleteUserSessions(id); err != nil {
		return err
	}
	if err := repo.DeleteAdminUser(id); err != nil {
		return err
	}
	return s.audit(actor, "account_delete", "admin_user",
		fmt.Sprintf("%d", id), fmt.Sprintf("username=%s role=%s", target.Username, target.Role))
}

func (s *ConsoleUserService) audit(adminName, action, targetType, targetID, detail string) error {
	if s.record == nil {
		return errors.New("console audit recorder is not configured")
	}
	if err := s.record(adminName, action, targetType, targetID, detail); err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

// validateConsoleUsername enforces the contract's 2..64 character window.
func validateConsoleUsername(username string) (string, error) {
	trimmed := strings.TrimSpace(username)
	if n := utf8.RuneCountInString(trimmed); n < 2 || n > 64 {
		return "", ErrConsoleInvalidUsername
	}
	return trimmed, nil
}

// validateConsolePassword enforces 8..128 characters AND bcrypt's hard 72-byte
// input limit (bcrypt would otherwise fail with an opaque error).
func validateConsolePassword(password string) error {
	if n := utf8.RuneCountInString(password); n < 8 || n > 128 {
		return ErrConsoleInvalidPassword
	}
	if len(password) > 72 {
		return ErrConsolePasswordTooLong
	}
	return nil
}
