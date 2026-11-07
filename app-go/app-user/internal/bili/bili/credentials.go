// Credential resolution ported from the old app-user resolver. The auth
// domain owns user_oauth and decryption, so this resolver consumes the shared
// contracts.BiliCredentialProvider instead of reading the table or holding the
// encryption key. The provider caches decrypted credentials in-process; no
// SESSDATA is written to Redis.
package bili

import (
	"context"
	"strconv"

	"app-user/internal/config"
	"app-user/internal/contracts"
)

// ErrNotLinked marks "this user has no usable bilibili binding" — a missing
// precondition the user fixes by scanning the bind QR, NOT an auth failure.
// Mapping it to 401 made the frontend treat every favorites call from an
// email-registered (unbound) user as "session expired" and log them out.
var ErrNotLinked = contracts.ErrNotLinked

// CredentialResolver produces ready bilibili clients per uid.
type CredentialResolver struct {
	cfg      *config.BiliConfig
	provider contracts.BiliCredentialProvider
}

// NewCredentialResolver wires the resolver with the auth-owned provider.
func NewCredentialResolver(cfg *config.BiliConfig, provider contracts.BiliCredentialProvider) *CredentialResolver {
	return &CredentialResolver{cfg: cfg, provider: provider}
}

// Resolve returns (client, mid). An error wrapping ErrNotLinked means the
// account is not linked (mapped to 409 by the HTTP layer).
func (r *CredentialResolver) Resolve(ctx context.Context, uid int64) (*Client, int64, error) {
	creds, err := r.provider.Credentials(ctx, uid)
	if err != nil {
		return nil, 0, err
	}
	client, cerr := NewClient(r.cfg, creds.Sessdata, "", strconv.FormatInt(creds.Mid, 10), creds.Mid)
	if cerr != nil {
		return nil, 0, cerr
	}
	return client, creds.Mid, nil
}
