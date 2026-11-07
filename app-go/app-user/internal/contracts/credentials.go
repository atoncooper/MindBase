// Package contracts holds the only interfaces/types shared between the
// app-user domains. Domains must not import each other; they depend on this
// package (and platform) instead.
package contracts

import (
	"context"
	"errors"
)

// ErrNotLinked marks "this user has no usable bilibili binding" — a missing
// precondition the user fixes by scanning the bind QR, NOT an auth failure.
// It maps to a business error (409) instead of 401 so the frontend does not
// log unbound users out.
var ErrNotLinked = errors.New("bilibili_not_linked")

// BiliCredentials is the decrypted bilibili session material for one user.
type BiliCredentials struct {
	Sessdata string
	Mid      int64
}

// BiliCredentialProvider is implemented by the auth domain (sole owner of the
// user_oauth table) and consumed by the bili domain.
type BiliCredentialProvider interface {
	// Credentials returns the decrypted SESSDATA + mid. An unbound user yields
	// an error wrapping ErrNotLinked; decryption failures yield a plain error
	// (mapped to 500).
	Credentials(ctx context.Context, uid int64) (*BiliCredentials, error)
}
