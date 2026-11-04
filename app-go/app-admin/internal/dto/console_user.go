package dto

// Console account management wire contract: the console
// accounts live in admin_user (the SAME table the login/session flow uses),
// independent of the payment database.
//
// Nullable timestamps stay pointers so "never logged in" serialises as null.

// ConsoleUserItem is one GET /api/console/users row.
type ConsoleUserItem struct {
	ID                 int64   `json:"id"`
	Username           string  `json:"username"`
	Role               string  `json:"role"`
	MustChangePassword bool    `json:"mustChangePassword"`
	LastLoginAt        *string `json:"lastLoginAt"`
	CreatedAt          *string `json:"createdAt"`
}

// ConsoleUserList is the GET /api/console/users body (username ASC).
type ConsoleUserList struct {
	Items []ConsoleUserItem `json:"items"`
}

// ConsoleUserCreated is the POST /api/console/users success body.
type ConsoleUserCreated struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}
