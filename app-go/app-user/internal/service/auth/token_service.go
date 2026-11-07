// Package service holds auth business logic on top of the repo layer.
package service

import (
	"app-user/internal/utils"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"app-user/internal/infra/cache"
	"app-user/internal/infra/security"
	"app-user/internal/model/auth"
	"app-user/internal/repo/auth"

	"gorm.io/gorm"
)

// TokenService — session token lifecycle: issue / validate / revoke, with the
// hot-path token→uid cache. Behavior mirrors the Python token.py.
type TokenService struct {
	db       *gorm.DB
	tokens   *repo.TokenRepo
	cache    *cache.Cache
	ttlDays  int
	mu       sync.Mutex           // guards lastBump
	lastBump map[string]time.Time // per-token last_activity write throttle
}

func NewTokenService(db *gorm.DB, ttlDays int, c *cache.Cache) *TokenService {
	return &TokenService{
		db:       db,
		tokens:   repo.NewTokenRepo(),
		cache:    c,
		ttlDays:  ttlDays,
		lastBump: make(map[string]time.Time),
	}
}

// Issue creates a fresh session token row and returns the token string.
// deviceID/ip/userAgent are best-effort metadata (nil tolerated).
func (s *TokenService) Issue(ctx context.Context, uid int64, deviceID, ip, userAgent *string) (string, error) {
	token, err := security.GenerateToken()
	if err != nil {
		return "", err
	}
	now := time.Now()
	expires := now.AddDate(0, 0, s.ttlDays)
	tt := "access"
	row := &model.UserToken{
		SessionToken: token,
		UID:          uid,
		DeviceID:     deviceID,
		TokenType:    &tt,
		ExpiresAt:    &expires,
		IP:           ip,
		UserAgent:    userAgent,
		IsRevoked:    utils.BoolPtr(false),
		CreatedAt:    &now,
	}
	if err := s.tokens.Create(s.db, row); err != nil {
		return "", err
	}
	s.cache.SetTokenUID(ctx, token, uid)
	return token, nil
}

// Validate returns the uid for a valid token, or 0 when invalid. L1/L2 cache
// is consulted first; DB hits refresh last_active_at at most once per minute
// (the Python side wrote per request — throttling here is a safe improvement
// that keeps the column fresh without a write per authenticated request).
func (s *TokenService) Validate(ctx context.Context, token string) int64 {
	if token == "" {
		return 0
	}
	// Revoked tombstones and negatively cached invalid tokens must be checked
	// before the positive cache: a concurrent Validate can otherwise re-add a
	// token that was being revoked at the same moment.
	if s.cache.IsBlocked(token) {
		return 0
	}
	if uid := s.cache.GetTokenUID(ctx, token); uid != 0 {
		s.bumpThrottled(token)
		return uid
	}
	row, err := s.tokens.FindValid(s.db, token)
	if err != nil {
		slog.Error("[AUTH_TOKEN] find_valid failed", "err", err)
		return 0
	}
	if row == nil {
		// Short L1 negative cache: random-token spam must not hit MySQL on
		// every forward-auth request.
		s.cache.MarkInvalid(token)
		return 0
	}
	if err := s.tokens.BumpActivity(s.db, token); err != nil {
		slog.Warn("[AUTH_TOKEN] bump activity failed", "err", err)
	}
	s.cache.SetTokenUID(ctx, token, row.UID)
	return row.UID
}

// Revoke revokes one token and drops it from the cache. The cache is cleared
// both before and after the DB write: a concurrent Validate that read the row
// just before the revoke must not be able to re-populate the cache afterwards.
func (s *TokenService) Revoke(ctx context.Context, token string) error {
	s.cache.DeleteToken(ctx, token)
	if err := s.tokens.Revoke(s.db, token); err != nil {
		return err
	}
	s.cache.DeleteToken(ctx, token)
	s.deleteBumpState(token)
	return nil
}

// RevokeAllForUser revokes every active token of a user. The token list is
// read first so cache entries can be deleted per token — never a global Redis
// SCAN (which would also evict every other user's cache).
func (s *TokenService) RevokeAllForUser(ctx context.Context, uid int64) error {
	rows, err := s.tokens.ListActive(s.db, uid)
	if err != nil {
		return err
	}
	if err := s.tokens.RevokeAllForUser(s.db, uid); err != nil {
		return err
	}
	for _, row := range rows {
		s.cache.DeleteToken(ctx, row.SessionToken)
		s.deleteBumpState(row.SessionToken)
	}
	return nil
}

// RevokeOthersForUser revokes all sessions except keepToken (password change).
func (s *TokenService) RevokeOthersForUser(ctx context.Context, uid int64, keepToken string) error {
	rows, err := s.tokens.ListActive(s.db, uid)
	if err != nil {
		return err
	}
	if _, err := s.tokens.RevokeOthersForUser(s.db, uid, keepToken); err != nil {
		return err
	}
	for _, row := range rows {
		if row.SessionToken == keepToken {
			continue
		}
		s.cache.DeleteToken(ctx, row.SessionToken)
		s.deleteBumpState(row.SessionToken)
	}
	return nil
}

// SessionID is the opaque, non-credential id exposed to the session-management
// UI. The real session token never leaves the server in list responses or URLs.
func SessionID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])[:16]
}

// RevokeBySessionID revokes one of uid's sessions by its public session id.
func (s *TokenService) RevokeBySessionID(ctx context.Context, uid int64, sessionID string) (bool, error) {
	rows, err := s.tokens.ListActive(s.db, uid)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if SessionID(row.SessionToken) != sessionID {
			continue
		}
		if err := s.Revoke(ctx, row.SessionToken); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

// RevokeOwned revokes a token only when it belongs to uid (ownership check
// for the DELETE /auth/tokens/{token} endpoint). Reports whether revoked.
func (s *TokenService) RevokeOwned(ctx context.Context, uid int64, token string) (bool, error) {
	row, err := s.tokens.FindValid(s.db, token)
	if err != nil {
		return false, err
	}
	if row == nil || row.UID != uid {
		return false, nil
	}
	if err := s.tokens.Revoke(s.db, token); err != nil {
		return false, err
	}
	s.cache.DeleteToken(ctx, token)
	s.deleteBumpState(token)
	return true, nil
}

// ListActive returns the user's active sessions (tokens management UI).
func (s *TokenService) ListActive(uid int64) ([]model.UserToken, error) {
	return s.tokens.ListActive(s.db, uid)
}

func (s *TokenService) bumpThrottled(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	// One last_active_at write per 5 minutes per token: this column is display
	// metadata only, and per-minute writes become a real write load at scale.
	if last, ok := s.lastBump[token]; ok && now.Sub(last) < 5*time.Minute {
		return
	}
	if len(s.lastBump) > 50_000 {
		s.lastBump = make(map[string]time.Time)
	}
	s.lastBump[token] = now
	go func(t string) {
		if err := s.tokens.BumpActivity(s.db, t); err != nil {
			slog.Warn("[AUTH_TOKEN] async bump failed", "err", err)
		}
	}(token)
}

func (s *TokenService) deleteBumpState(token string) {
	s.mu.Lock()
	delete(s.lastBump, token)
	s.mu.Unlock()
}

func (s *TokenService) clearBumpState() {
	s.mu.Lock()
	s.lastBump = make(map[string]time.Time)
	s.mu.Unlock()
}
