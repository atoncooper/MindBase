package dto

// UserItem is one /api/users row (account metadata only).
type UserItem struct {
	UID       int64    `json:"uid"`
	Email     string   `json:"email"`
	Phone     string   `json:"phone"`
	Nickname  string   `json:"nickname"`
	Status    string   `json:"status"`
	Roles     []string `json:"roles"`
	CreatedAt string   `json:"createdAt,omitempty"`
}

// RoleDetail is one rbac binding on the user detail view: granted / expires /
// isActive, exactly the contract fields.
type RoleDetail struct {
	RoleID   string `json:"roleId"`
	Name     string `json:"name"`
	Granted  string `json:"granted,omitempty"`
	Expires  string `json:"expires,omitempty"`
	IsActive bool   `json:"isActive"`
}

// UserPage is the /api/users list envelope. QueryMode echoes the validated
// lookup mode (uid/phone/email; empty when listing all), so the console can
// confirm what the backend actually queried.
type UserPage struct {
	Items     []UserItem `json:"items"`
	Total     int64      `json:"total"`
	Page      int        `json:"page"`
	PageSize  int        `json:"pageSize"`
	QueryMode string     `json:"queryMode,omitempty"`
}

// UserDetail is the /api/users/:uid body (base fields + full role bindings).
type UserDetail struct {
	UID       int64        `json:"uid"`
	Email     string       `json:"email"`
	Phone     string       `json:"phone"`
	Nickname  string       `json:"nickname"`
	Status    string       `json:"status"`
	CreatedAt string       `json:"createdAt,omitempty"`
	Roles     []RoleDetail `json:"roles"`
}
