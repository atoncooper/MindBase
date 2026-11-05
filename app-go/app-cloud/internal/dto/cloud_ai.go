// Package dto holds the wire representations served by app-cloud handlers.
// Domain models (model.*) and service results stay internal: handlers map them
// to these structs so JSON field names, nullability and empty-array behavior
// are defined in one place instead of ad-hoc gin.H maps.
package dto

// Summary is the persisted AI summary as exposed over the API. List fields are
// always present (empty array, never null) so clients can render them without
// null checks.
type Summary struct {
	Overview         string   `json:"overview"`
	Topics           []string `json:"topics"`
	Entities         []string `json:"entities"`
	KeyPoints        []string `json:"key_points"`
	Todos            []string `json:"todos"`
	AnswersQuestions []string `json:"answers_questions"`
	Language         string   `json:"language"`
	SizeChars        int      `json:"size_chars"`
}

// SummaryResponse is returned by the owner and M2M summary endpoints. Identity
// fields are present even when no summary exists yet.
type SummaryResponse struct {
	UploadUUID   string   `json:"upload_uuid"`
	OriginalName string   `json:"original_name"`
	Title        string   `json:"title"`
	Available    bool     `json:"available"`
	Stale        bool     `json:"stale"`
	Model        string   `json:"model"`
	Summary      *Summary `json:"summary"`
}

// SemanticHit is one ranked drive file; snippets are distinct matching chunks.
type SemanticHit struct {
	UploadUUID   string   `json:"upload_uuid"`
	OriginalName string   `json:"original_name"`
	Title        string   `json:"title"`
	MimeType     string   `json:"mime_type"`
	FileSize     int64    `json:"file_size"`
	Score        float64  `json:"score"`
	Snippets     []string `json:"snippets"`
}

// SemanticSearchResponse is the semantic-search endpoint payload.
type SemanticSearchResponse struct {
	Mode    string        `json:"mode"`
	Results []SemanticHit `json:"results"`
	Total   int           `json:"total"`
}

// SimilarResponse is the similar-files endpoint payload (owner and M2M).
type SimilarResponse struct {
	Items []SemanticHit `json:"items"`
}
