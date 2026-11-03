package runtime

import "errors"

var (
	errFakeCreate = errors.New("fake runtime: create failed (injected)")
	errFakeExec   = errors.New("fake runtime: exec failed (injected)")
)
