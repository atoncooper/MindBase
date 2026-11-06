// Package service is the business layer of app-kg: KG rules (bookkeeping
// state machine, scope resolution, evidence title join, stats composition,
// input validation) plus orchestration of the repo layer. It never speaks
// gRPC/HTTP and never opens a database connection — the layering is pinned by
// internal/arch/arch_test.go.
package service

import (
	"errors"
	"fmt"
)

// ErrPageNotFound — the (bvid, cid) row does not exist. Transport maps it to
// a "found=false" proto result rather than an RPC error (contract of
// BeginPage).
var ErrPageNotFound = errors.New("video page not found")

// InvalidArgumentError — the caller's input violates the domain contract.
// Transport maps it to codes.InvalidArgument (gRPC) or HTTP 422.
type InvalidArgumentError struct {
	Msg string
}

func (e *InvalidArgumentError) Error() string { return e.Msg }

// invalidf builds an InvalidArgumentError.
func invalidf(format string, args ...any) error {
	return &InvalidArgumentError{Msg: fmt.Sprintf(format, args...)}
}
