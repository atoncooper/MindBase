// Typed HTTP response contracts for the B站 acquisition domain. Routers map
// service results into these DTOs so the wire schema lives at the boundary.
package bili

// FavoriteFolder is one folder row in GET /favorites/v2/list and in the
// folders array of POST /favorites/v2/sync.
type FavoriteFolder struct {
	ID         int64   `json:"id"`
	MediaID    int64   `json:"media_id"`
	Title      string  `json:"title"`
	MediaCount int     `json:"media_count"`
	IsDefault  bool    `json:"is_default"`
	IsSelected bool    `json:"is_selected"`
	LastSyncAt *string `json:"last_sync_at,omitempty"`
}

// FolderSync is POST /favorites/v2/sync.
type FolderSync struct {
	Folders []FavoriteFolder `json:"folders"`
	Total   int              `json:"total"`
}

// FolderSelected is PATCH /favorites/v2/{folder_id}/selected.
type FolderSelected struct {
	FolderID   int64 `json:"folder_id"`
	IsSelected bool  `json:"is_selected"`
}

// FolderDeleted is DELETE /favorites/v2/{folder_id}.
type FolderDeleted struct {
	Message  string `json:"message"`
	FolderID int64  `json:"folder_id"`
}

// ASRUpdateResult is POST /asr/update.
type ASRUpdateResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// Ownership is GET /internal/bili/owns.
type Ownership struct {
	Bvid    string `json:"bvid"`
	Belongs bool   `json:"belongs"`
}

// ScopePage mirrors one video page row (ASR state included — the AI side
// needs is_processed/version to decide whether ASR must run before embedding).
type ScopePage struct {
	CID         int64  `json:"cid"`
	PageIndex   int    `json:"page_index"`
	PageTitle   string `json:"page_title"`
	IsProcessed bool   `json:"is_processed"`
	Version     int    `json:"version"`
}

// ScopeVideo is one video in the knowledge-scope tree.
type ScopeVideo struct {
	BvID  string      `json:"bvid"`
	Title string      `json:"title"`
	Pages []ScopePage `json:"pages"`
}

// ScopeFolder is one collection folder in the knowledge-scope tree.
type ScopeFolder struct {
	MediaID    int64        `json:"media_id"`
	MediaCount *int         `json:"media_count"`
	LastSyncAt string       `json:"last_sync_at"`
	Videos     []ScopeVideo `json:"videos"`
}

// ScopeResult is GET /internal/bili/scope.
type ScopeResult struct {
	Folders []ScopeFolder `json:"folders"`
}
