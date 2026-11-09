// Package bili defines the HTTP request DTOs for the B站 acquisition domain
// (favorites / knowledge build / ASR). Routers bind these types and the
// service layer owns the business rules; the DTO layer must not import
// service, repo or router packages.
package bili

// FolderIDsRequest is POST /favorites/organize/execute and
// POST /knowledge/folders/sync.
type FolderIDsRequest struct {
	FolderIDs []int64 `json:"folder_ids"`
}

// BuildRequest is POST /knowledge/build. exclude_bvids is accepted for wire
// compatibility; build orchestration consumes folder_ids.
type BuildRequest struct {
	FolderIDs    []int64  `json:"folder_ids"`
	ExcludeBvids []string `json:"exclude_bvids"`
}

// CleanInvalidRequest is POST /favorites/organize/clean-invalid.
type CleanInvalidRequest struct {
	FolderID int64 `json:"folder_id"`
}

// ASRCreateRequest is POST /asr/create.
type ASRCreateRequest struct {
	BvID      string `json:"bvid"`
	CID       int64  `json:"cid"`
	PageIndex int    `json:"page_index"`
	PageTitle string `json:"page_title"`
}

// ASRUpdateRequest is POST /asr/update.
type ASRUpdateRequest struct {
	BvID      string `json:"bvid"`
	CID       int64  `json:"cid"`
	PageIndex int    `json:"page_index"`
	Content   string `json:"content"`
}

// ASRReASRRequest is POST /asr/reasr.
type ASRReASRRequest struct {
	BvID      string `json:"bvid"`
	CID       int64  `json:"cid"`
	PageIndex int    `json:"page_index"`
}
