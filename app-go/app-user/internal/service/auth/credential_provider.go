package service

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"app-user/internal/contracts"
	"app-user/internal/infra/security"
	authrepo "app-user/internal/repo/auth"

	"gorm.io/gorm"
)

// BiliCredentialProvider decrypts the user's stored bilibili SESSDATA for the
// bili domain. It is the single place inside app-user allowed to expose
// user_oauth credentials, and does so through the auth repo (no SQL here).
//
// Decrypted credentials are cached IN-PROCESS only (never in the shared
// Redis). The previous Redis cache stored plaintext SESSDATA where any other
// Redis consumer could read it, and had no invalidation on re-bind. Binding /
// refreshing invalidates the local entry immediately; other replicas are
// bounded by the short TTL.
type BiliCredentialProvider struct {
	db     *gorm.DB
	cipher *security.Cipher
	oauth  *authrepo.OAuthRepo

	mu    sync.Mutex
	cache map[int64]cachedBiliCred
}

type cachedBiliCred struct {
	creds   contracts.BiliCredentials
	expires time.Time
}

const (
	biliCredCacheTTL = 5 * time.Minute
	biliCredMaxItems = 5000
)

// NewBiliCredentialProvider wires the provider with the shared cipher.
func NewBiliCredentialProvider(db *gorm.DB, cipher *security.Cipher) *BiliCredentialProvider {
	return &BiliCredentialProvider{
		db:     db,
		cipher: cipher,
		oauth:  authrepo.NewOAuthRepo(),
		cache:  make(map[int64]cachedBiliCred),
	}
}

// Invalidate drops the cached credential (called after a bind / SESSDATA
// refresh). Safe on nil receiver.
func (p *BiliCredentialProvider) Invalidate(uid int64) {
	if p == nil || uid <= 0 {
		return
	}
	p.mu.Lock()
	delete(p.cache, uid)
	p.mu.Unlock()
}

// Credentials implements contracts.BiliCredentialProvider.
func (p *BiliCredentialProvider) Credentials(ctx context.Context, uid int64) (*contracts.BiliCredentials, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("invalid uid: %w", contracts.ErrNotLinked)
	}
	now := time.Now()
	p.mu.Lock()
	if entry, ok := p.cache[uid]; ok && now.Before(entry.expires) {
		creds := entry.creds
		p.mu.Unlock()
		return &creds, nil
	}
	p.mu.Unlock()

	oauth, err := p.oauth.GetByUIDProvider(p.db.WithContext(ctx), uid, "bilibili")
	if err != nil {
		return nil, fmt.Errorf("query user_oauth: %w", err)
	}
	if oauth == nil || oauth.AccessToken == nil || *oauth.AccessToken == "" {
		return nil, fmt.Errorf("no user_oauth row: %w", contracts.ErrNotLinked)
	}
	sessdata, err := p.cipher.Decrypt(*oauth.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("decrypt SESSDATA: %w", err)
	}
	if sessdata == "" {
		return nil, fmt.Errorf("empty SESSDATA after decrypt: %w", contracts.ErrNotLinked)
	}
	mid := int64(0)
	if n, perr := strconv.ParseInt(oauth.ProviderUID, 10, 64); perr == nil {
		mid = n
	}
	creds := contracts.BiliCredentials{Sessdata: sessdata, Mid: mid}
	p.mu.Lock()
	if len(p.cache) > biliCredMaxItems {
		for k, e := range p.cache {
			if !now.Before(e.expires) {
				delete(p.cache, k)
			}
		}
		if len(p.cache) > biliCredMaxItems {
			for k := range p.cache {
				delete(p.cache, k)
				if len(p.cache) <= biliCredMaxItems {
					break
				}
			}
		}
	}
	p.cache[uid] = cachedBiliCred{creds: creds, expires: now.Add(biliCredCacheTTL)}
	p.mu.Unlock()
	return &creds, nil
}
