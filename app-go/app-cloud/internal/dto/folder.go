package dto

import "encoding/json"

// Folder endpoints keep the legacy mixed casing: request bodies and the
// tree/list payloads are snake_case, while create/update responses are the
// legacy snake_case shape clients already tolerate.

// FolderCreateRequest is the POST /cloud/folders body.
type FolderCreateRequest struct {
	ParentID *int64 `json:"parentId"`
	Name     string `json:"name" binding:"required"`
}

// FolderUpdateRequest is the PATCH /cloud/folders/{id} body. Presence of
// parentId matters (absent = keep, null = move to root), so it is decoded
// manually instead of through plain pointers.
type FolderUpdateRequest struct {
	Name    *string
	NameSet bool

	ParentID      *int64
	ParentSet     bool
	ParentInvalid bool
}

// UnmarshalJSON records which fields the caller actually sent.
func (r *FolderUpdateRequest) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["name"]; ok {
		r.NameSet = true
		if !isJSONNull(v) {
			var name string
			if err := json.Unmarshal(v, &name); err != nil {
				return err
			}
			r.Name = &name
		}
	}
	if v, ok := raw["parentId"]; ok {
		r.ParentSet = true
		if !isJSONNull(v) {
			id, ok := parseJSONInt64(v)
			if !ok {
				r.ParentInvalid = true
			} else {
				r.ParentID = &id
			}
		}
	}
	return nil
}

// FolderItem is one node of the folder tree.
type FolderItem struct {
	ID         int64        `json:"id"`
	ParentID   *int64       `json:"parent_id"`
	Name       string       `json:"name"`
	VideoCount int          `json:"video_count"`
	Children   []FolderItem `json:"children"`
}

// FolderTreeResponse is the GET /cloud/folders payload.
type FolderTreeResponse struct {
	Folders []FolderItem `json:"folders"`
}

// FolderResponse is one folder (create/update responses).
type FolderResponse struct {
	ID         int64  `json:"id"`
	ParentID   *int64 `json:"parent_id"`
	Name       string `json:"name"`
	VideoCount int    `json:"video_count"`
}

// FolderDeleteResponse is the DELETE /cloud/folders/{id} payload.
type FolderDeleteResponse struct {
	Deleted       bool  `json:"deleted"`
	AffectedFiles int64 `json:"affectedFiles"`
}
