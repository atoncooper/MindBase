// Read-only queries over the identity tables (users / user_profile /
// rbac_user_role / rbac_role — owned by app-auth). Zero writes, zero
// migrations; admin sees only account metadata (uid / email / phone /
// nickname / status / granted roles).
package repo

import (
	"strconv"
	"time"

	"app-admin/internal/db"
)

// RoleBinding is one rbac_user_role row joined with its role display name.
type RoleBinding struct {
	RoleID    string
	RoleName  string
	GrantedAt *time.Time
	ExpiresAt *time.Time
	IsActive  *bool
}

// UserAccount is one admin-plane user row (list item or detail base).
type UserAccount struct {
	UID       int64
	Email     *string
	Phone     *string
	Status    *string
	Nickname  *string
	CreatedAt *time.Time
}

// ActiveOnlyExpr is the app-auth "binding in force" predicate: is_active
// counts as active when NULL (legacy rows) and the expiry must not have passed.
const activeBindingSQL = "(ur.is_active IS NULL OR ur.is_active = 1) AND (ur.expires_at IS NULL OR ur.expires_at > NOW())"

// UserQuery is one validated admin user lookup: exactly one of uid / 11-digit
// phone / email (exact match). Mode "" with empty Value = list all accounts.
// The service layer validates/infers the mode; repo only executes it.
type UserQuery struct {
	Mode  string // "" | uid | phone | email
	Value string
}

// ListUsers pages the (not soft-deleted) accounts. The query is an exact
// uid / phone / email match (validated by the service) — no fuzzy nickname
// matching, so a typo can never silently return someone else's account.
func ListUsers(q UserQuery, limit, offset int) ([]UserAccount, int64, error) {
	base := "FROM users u LEFT JOIN user_profile p ON p.uid = u.uid " +
		"WHERE u.deleted_at IS NULL"
	var args []any
	switch q.Mode {
	case "uid":
		uid, err := strconv.ParseInt(q.Value, 10, 64)
		if err != nil {
			// The service validates this; a malformed value simply matches no row.
			base += " AND 1=0"
		} else {
			base += " AND u.uid = ?"
			args = append(args, uid)
		}
	case "phone":
		base += " AND u.phone = ?"
		args = append(args, q.Value)
	case "email":
		// Case-insensitive exact email match; the collation may already be ci,
		// LOWER() keeps the behavior explicit across schemas.
		base += " AND LOWER(u.email) = LOWER(?)"
		args = append(args, q.Value)
	}

	var total int64
	if err := db.DB.Raw("SELECT COUNT(*) "+base, args...).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	rowsSQL := "SELECT u.uid, u.email, u.phone, u.status, u.created_at, p.nickname " + base +
		" ORDER BY u.uid LIMIT ? OFFSET ?"
	args2 := append(append([]any{}, args...), limit, offset)
	rows, err := db.DB.Raw(rowsSQL, args2...).Rows()
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var items []UserAccount
	for rows.Next() {
		var it UserAccount
		if err := db.DB.ScanRows(rows, &it); err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, rows.Err()
}

// GetUser fetches one account by uid (nil when absent / soft-deleted).
func GetUser(uid int64) (*UserAccount, error) {
	var it UserAccount
	err := db.DB.Raw(
		"SELECT u.uid, u.email, u.phone, u.status, u.created_at, p.nickname "+
			"FROM users u LEFT JOIN user_profile p ON p.uid = u.uid "+
			"WHERE u.uid = ? AND u.deleted_at IS NULL", uid).Scan(&it).Error
	if err != nil {
		return nil, err
	}
	if it.UID == 0 {
		return nil, nil
	}
	return &it, nil
}

// ActiveRolesByUids returns the ACTIVE role bindings for a page of users
// (granted/expires/isActive detail lives on GetUserRoleBindings for detail
// view; here the list endpoint only needs names).
func ActiveRolesByUids(uids []int64) (map[int64][]RoleBinding, error) {
	out := make(map[int64][]RoleBinding, len(uids))
	if len(uids) == 0 {
		return out, nil
	}
	rows, err := db.DB.Raw(
		"SELECT ur.uid, ur.role_id, COALESCE(r.name, ur.role_id) AS role_name, "+
			"ur.granted_at, ur.expires_at, ur.is_active "+
			"FROM rbac_user_role ur LEFT JOIN rbac_role r ON r.role_id = ur.role_id "+
			"WHERE ur.uid IN (?) AND "+activeBindingSQL+
			" ORDER BY ur.uid, ur.id", uids).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type rowWithUID struct {
		RoleBinding
		UID int64
	}
	for rows.Next() {
		var rw rowWithUID
		if err := db.DB.ScanRows(rows, &rw); err != nil {
			return nil, err
		}
		out[rw.UID] = append(out[rw.UID], rw.RoleBinding)
	}
	return out, rows.Err()
}

// GetUserRoleBindings returns ALL rbac bindings of one user (active or not)
// for the detail endpoint (granted / expires / isActive shown to the admin).
func GetUserRoleBindings(uid int64) ([]RoleBinding, error) {
	rows, err := db.DB.Raw(
		"SELECT ur.role_id, COALESCE(r.name, ur.role_id) AS role_name, "+
			"ur.granted_at, ur.expires_at, ur.is_active "+
			"FROM rbac_user_role ur LEFT JOIN rbac_role r ON r.role_id = ur.role_id "+
			"WHERE ur.uid = ? ORDER BY ur.id", uid).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []RoleBinding
	for rows.Next() {
		var b RoleBinding
		if err := db.DB.ScanRows(rows, &b); err != nil {
			return nil, err
		}
		items = append(items, b)
	}
	return items, rows.Err()
}
