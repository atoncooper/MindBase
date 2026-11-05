// Package utils holds the pure helpers shared across app-cloud packages
// (pipeline / service / repo / milvusstore). Keep it small and dependency-free
// so it cannot become a dumping ground for business logic.
package utils

import (
	"strings"
	"unicode/utf8"

	"app-cloud/internal/model"
)

// DisplayTitle is the canonical display title for a drive file: the user-set
// title when present, otherwise the original file name. Used for embeddings,
// summaries and search results so every surface labels a file the same way.
func DisplayTitle(f *model.CloudFile) string {
	if f == nil {
		return ""
	}
	if f.Title != nil && strings.TrimSpace(*f.Title) != "" {
		return *f.Title
	}
	return f.OriginalName
}

// TruncateBytes returns s cut to at most n bytes without splitting a
// multi-byte UTF-8 rune. Used before writing into fixed-width storage columns
// (Milvus varchar fields, MySQL error text).
func TruncateBytes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	cut := s[:n]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// TruncateRunes returns s cut to at most n runes (display/snippet limit).
func TruncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
