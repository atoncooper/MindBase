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

// KGDocumentsItem is one parsed cloud document listed for cloud-driven KG
// builds. The body text is deliberately absent (fetch it per document); the
// listing must stay small even for users with thousands of documents.
type KGDocumentsItem struct {
	UploadUUID  string `json:"upload_uuid"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	// SizeChars is the document's character count (0 = recorded size unknown,
	// i.e. parsed before size_chars was persisted). The per-document endpoint
	// always reports the exact value.
	SizeChars int `json:"size_chars"`
}

// KGDocumentsResponse is one page of the KG document listing. next_cursor is
// the last upload_uuid of a full page and null on the last page.
type KGDocumentsResponse struct {
	Items      []KGDocumentsItem `json:"items"`
	NextCursor *string           `json:"next_cursor"`
}

// KGDocumentResponse is one parsed document with its body text (truncated
// server-side to the KG extraction budget). size_chars counts the full text,
// not the returned slice, so callers can tell truncated documents apart.
type KGDocumentResponse struct {
	UploadUUID  string `json:"upload_uuid"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	SizeChars   int    `json:"size_chars"`
	Text        string `json:"text"`
}
