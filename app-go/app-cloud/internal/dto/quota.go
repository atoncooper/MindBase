package dto

// QuotaResponse is the GET /cloud/quota payload. Error is only present when
// the usage lookup failed (the numeric fields then carry fail-closed values).
type QuotaResponse struct {
	Used    int64  `json:"used"`
	Quota   int64  `json:"quota"`
	Tier    string `json:"tier"`
	Pending int64  `json:"pending"`
	Error   string `json:"error,omitempty"`
}
