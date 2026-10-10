// Credential resolution — port of
// app/services/auth/bilibili_credentials.py: read the linked bilibili row
// from user_oauth (READ-ONLY; schema owned by app-auth), AES-decrypt the
// SESSDATA (shared key, format pinned by app-auth's compat_test), and cache
// in Redis for 10 minutes.
package bili

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"app-bili/internal/config"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// ErrNotLinked marks "this user has no usable bilibili binding" — a missing
// precondition the user fixes by scanning the bind QR, NOT an auth failure.
// Mapping it to 401 made the frontend treat every favorites call from an
// email-registered (unbound) user as "session expired" and log them out.
var ErrNotLinked = errors.New("bilibili_not_linked")

// userOAuthRow mirrors the user_oauth columns app-bili reads (never writes).
type userOAuthRow struct {
	UID         int64  `gorm:"column:uid"`
	Provider    string `gorm:"column:provider"`
	ProviderUID string `gorm:"column:provider_uid"`
	AccessToken string `gorm:"column:access_token"`
}

func (userOAuthRow) TableName() string { return "user_oauth" }

// CredentialResolver produces ready bilibili clients per uid.
type CredentialResolver struct {
	cfg *config.Config
	db  *gorm.DB
	rdb redis.UniversalClient
	ttl time.Duration
}

func NewCredentialResolver(cfg *config.Config, db *gorm.DB, rdb redis.UniversalClient) *CredentialResolver {
	return &CredentialResolver{cfg: cfg, db: db, rdb: rdb, ttl: 10 * time.Minute}
}

// Resolve returns (client, mid). 401-equivalent error when the account is
// not linked (parity with the Python HTTPException(401)).
func (r *CredentialResolver) Resolve(ctx context.Context, uid int64) (*Client, int64, error) {
	type cred struct {
		Sessdata string
		Mid      int64
	}
	var (
		cached cred
		found  bool
	)
	if r.rdb != nil {
		if raw, err := r.rdb.Get(ctx, fmt.Sprintf("mind-base:bili-cred:%d", uid)).Result(); err == nil {
			if json.Unmarshal([]byte(raw), &cached) == nil && cached.Sessdata != "" {
				found = true
			}
		}
	}
	if !found {
		var row userOAuthRow
		err := r.db.WithContext(ctx).
			Where("uid = ? AND provider = ?", uid, "bilibili").
			First(&row).Error
		if err != nil {
			return nil, 0, fmt.Errorf("no user_oauth row: %w", ErrNotLinked)
		}
		if row.AccessToken == "" {
			return nil, 0, fmt.Errorf("empty access_token: %w", ErrNotLinked)
		}
		cipher, cerr := NewCipher(r.cfg.Bili.EncryptionKey)
		if cerr != nil {
			return nil, 0, fmt.Errorf("decrypt SESSDATA: %w", cerr)
		}
		sessdata, derr := cipher.Decrypt(row.AccessToken)
		if derr != nil {
			// Decrypt failure is server-side (key mismatch / corrupt row), not
			// a user-fixable "not linked" — keep it a plain error (maps to 500).
			return nil, 0, fmt.Errorf("decrypt SESSDATA: %w", derr)
		}
		if sessdata == "" {
			return nil, 0, fmt.Errorf("empty SESSDATA after decrypt: %w", ErrNotLinked)
		}
		mid := int64(0)
		if n, perr := strconv.ParseInt(row.ProviderUID, 10, 64); perr == nil {
			mid = n
		}
		cached = cred{Sessdata: sessdata, Mid: mid}
		if r.rdb != nil {
			if raw, merr := json.Marshal(cached); merr == nil {
				r.rdb.Set(ctx, fmt.Sprintf("mind-base:bili-cred:%d", uid), raw, r.ttl)
			}
		}
	}

	client, cerr := NewClient(r.cfg, cached.Sessdata, "", strconv.FormatInt(cached.Mid, 10), cached.Mid)
	if cerr != nil {
		return nil, 0, cerr
	}
	return client, cached.Mid, nil
}
