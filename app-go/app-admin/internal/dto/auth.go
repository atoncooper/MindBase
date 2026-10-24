package dto

// SessionInfo is the body of both POST /api/login and GET /api/me
// (username / role / mustChangePassword).
type SessionInfo struct {
	Username           string `json:"username"`
	Role               string `json:"role"`
	MustChangePassword bool   `json:"mustChangePassword"`
}
