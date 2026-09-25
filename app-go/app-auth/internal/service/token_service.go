// Package service holds auth business logic on top of the repo layer.
package service

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"app-auth/internal/cache"
	"app-auth/internal/model"
	"app-auth/internal/repo"
	"app-auth/internal/security"

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
		IsRevoked:    boolPtr(false),
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
		return 0
	}
	if err := s.tokens.BumpActivity(s.db, token); err != nil {
		slog.Warn("[AUTH_TOKEN] bump activity failed", "err", err)
	}
	s.cache.SetTokenUID(ctx, token, row.UID)
	return row.UID
}

// Revoke revokes one token and drops it from the cache.
func (s *TokenService) Revoke(ctx context.Context, token string) error {
	if err := s.tokens.Revoke(s.db, token); err != nil {
		return err
	}
	s.cache.DeleteToken(ctx, token)
	s.deleteBumpState(token)
	return nil
}

// RevokeAllForUser revokes every active token of a user and clears the cache
// namespace (bounded scan).
func (s *TokenService) RevokeAllForUser(ctx context.Context, uid int64) error {
	if err := s.tokens.RevokeAllForUser(s.db, uid); err != nil {
		return err
	}
	s.cache.DeleteAllTokens(ctx)
	s.clearBumpState()
	return nil
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
	if last, ok := s.lastBump[token]; ok && now.Sub(last) < time.Minute {
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

func boolPtr(b bool) *bool { return &b }
