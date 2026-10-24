// Shared service helpers: pagination window (page from 1, pageSize <= 100,
// default 20 per plan/1.0.16) and field presentation utilities used while
// assembling the internal/dto response shapes.
package service

import (
	"errors"
	"time"
)

const (
	defaultPageSize = 20
	maxPageSize     = 100
)

func validatePage(page, pageSize int) error {
	if page < 1 {
		return errors.New("page must be >= 1")
	}
	if pageSize < 1 {
		return errors.New("pageSize must be >= 1")
	}
	if pageSize > maxPageSize {
		return errors.New("pageSize must be <= 100")
	}
	return nil
}

// pageWindow converts 1-based page semantics into LIMIT / OFFSET.
func pageWindow(page, pageSize int) (limit, offset int) {
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if page <= 0 {
		page = 1
	}
	return pageSize, (page - 1) * pageSize
}

func safeStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// rfc3339 renders instants in RFC3339 so admin frontends parse them natively.
func rfc3339(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

// isActive resolves an rbac binding "in force": NULL is_active counts as
// active; an expiry in the past deactivates it regardless.
func isActive(flag *bool, expires *time.Time) bool {
	if flag != nil && !*flag {
		return false
	}
	if expires != nil && expires.Before(time.Now()) {
		return false
	}
	return true
}

// truncateRunes caps s to at most n runes without splitting a multi-byte
// character (audit detail is varchar(500); the console shows one line).
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

func isBlank(s string) bool {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ' ', '\t', '\n', '\r':
			continue
		default:
			return false
		}
	}
	return true
}
