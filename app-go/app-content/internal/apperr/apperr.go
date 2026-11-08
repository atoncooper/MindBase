// Package apperr is the single application-error model shared by all domains:
// one type carries the HTTP status, a stable machine code, the user-facing
// detail and (optionally) a structured detail object. HTTP handlers render it
// through middleware.RespondError, so board/note/quiz no longer invent three
// different error conventions.
package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is a typed application error. It implements error and unwraps the
// underlying cause (if any) so errors.Is/As keep working.
type Error struct {
	Status int            // HTTP status
	Code   string         // stable machine-readable code
	Detail string         // user-facing message
	Meta   map[string]any // optional structured detail (rendered as {"detail": Meta})
	Err    error          // underlying cause (logged, never rendered)
}

// Error renders the detail (plus cause for logs).
func (e *Error) Error() string {
	if e.Err != nil {
		return e.Detail + ": " + e.Err.Error()
	}
	return e.Detail
}

// Unwrap exposes the underlying cause.
func (e *Error) Unwrap() error { return e.Err }

// New builds an application error.
func New(status int, code, detail string) *Error {
	return &Error{Status: status, Code: code, Detail: detail}
}

// Wrap builds an application error around a cause.
func Wrap(status int, code, detail string, err error) *Error {
	return &Error{Status: status, Code: code, Detail: detail, Err: err}
}

// WithMeta attaches a structured detail object (rendered as the detail value).
func (e *Error) WithMeta(meta map[string]any) *Error {
	e.Meta = meta
	return e
}

// As extracts the first *Error in the chain.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// CodeFor derives a stable machine code from an HTTP status (fallback for
// call sites that only know the status).
func CodeFor(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "invalid_input"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusPreconditionRequired:
		return "precondition_required"
	case http.StatusRequestEntityTooLarge:
		return "payload_too_large"
	case http.StatusServiceUnavailable:
		return "storage_unavailable"
	default:
		if status >= 500 {
			return "internal_error"
		}
		return fmt.Sprintf("http_%d", status)
	}
}
