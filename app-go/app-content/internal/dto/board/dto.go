// Package board defines the HTTP wire contract for the board domain: request
// DTOs with validation tags and response DTOs. Routers bind/validate these
// types and map service views themselves; the DTO layer has no dependency on
// the service packages.
package board

import (
	"encoding/json"
	"strings"
)

// RawContent keeps the client's JSON verbatim (the editors' formats are opaque
// to the service: simple-mind-map tree / Excalidraw scene).
//
// Two client shapes are accepted:
//   - raw object/array token:  {"content": {"root": ...}}  -> stored verbatim;
//   - pre-stringified string:  {"content": "{"root": ...}"}  -> unquoted.
type RawContent string

// UnmarshalJSON implements the dual-shape contract above.
func (j *RawContent) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var unquoted string
		if err := json.Unmarshal(data, &unquoted); err != nil {
			return err
		}
		*j = RawContent(unquoted)
		return nil
	}
	*j = RawContent(data)
	return nil
}

// CreateRequest is POST /board/boards.
type CreateRequest struct {
	Title   *string     `json:"title" binding:"omitempty,max=255"`
	Kind    string      `json:"kind" binding:"omitempty,oneof=mindmap whiteboard"`
	Content *RawContent `json:"content"`
}

// UpdateRequest is PUT /board/boards/:uuid (optimistic lock via If-Match).
type UpdateRequest struct {
	Title    *string     `json:"title" binding:"omitempty,max=255"`
	Content  *RawContent `json:"content"`
	IsPinned *bool       `json:"isPinned"`
}

// PinRequest is PATCH /board/boards/:uuid/pin.
type PinRequest struct {
	IsPinned *bool `json:"isPinned" binding:"required"`
}

// ListQuery is GET /board/boards; call Normalize to apply bounds.
type ListQuery struct {
	Kind     string
	Page     int
	PageSize int
}

// Normalize applies the API contract bounds (kind ∈ {mindmap, whiteboard, ""},
// page ≥ 1, page_size 1..100).
func (q *ListQuery) Normalize() bool {
	if q.Kind != "" && q.Kind != "mindmap" && q.Kind != "whiteboard" {
		return false
	}
	if q.Page < 1 || q.PageSize < 1 || q.PageSize > 100 {
		return false
	}
	return true
}

// Meta is the board list item response.
type Meta struct {
	UUID      string `json:"uuid"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	Version   int64  `json:"version"`
	IsPinned  bool   `json:"isPinned"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Detail is the board detail response (content is opaque JSON).
type Detail struct {
	Meta
	Content *string `json:"content"`
}
