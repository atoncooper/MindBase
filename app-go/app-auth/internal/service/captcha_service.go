package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"time"

	"app-auth/internal/config"

	"github.com/mojocn/base64Captcha"
	"github.com/redis/go-redis/v9"
)

// CaptchaService — graphical captcha gate. Answers are stored in Redis as
// SHA-256 digests; verification is an atomic Lua compare-and-delete so every
// captcha is single-use (consumed on success AND failure). When Redis is
// unavailable or the feature is off the gate fails open and generate()
// reports required=false so the frontend hides the input — same degradation
// as the Python captcha_service.
type CaptchaService struct {
	cfg *config.Config
	rdb redis.UniversalClient
}

const captchaNS = "mind-base:auth:captcha:"

func NewCaptchaService(cfg *config.Config, rdb redis.UniversalClient) *CaptchaService {
	return &CaptchaService{cfg: cfg, rdb: rdb}
}

func (s *CaptchaService) key(id string) string { return captchaNS + id }

func (s *CaptchaService) digest(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// CaptchaResult is the GET /auth/captcha payload.
type CaptchaResult struct {
	CaptchaID   string
	ImageBase64 string // data URL
	ExpiresIn   int
	Required    bool
}

// Generate creates a fresh captcha. required=false signals degradation.
func (s *CaptchaService) Generate(ctx context.Context) (*CaptchaResult, error) {
	if !s.cfg.Security.Captcha.Enabled || s.rdb == nil {
		return &CaptchaResult{Required: false}, nil
	}
	driver := base64Captcha.NewDriverString(
		s.cfg.Security.Captcha.ImageHeight,
		s.cfg.Security.Captcha.ImageWidth,
		0, // noiseCount: lines provide enough noise
		2, // showLineOptions: curved lines
		s.cfg.Security.Captcha.Length,
		"ABCDEFGHJKMNPQRSTUVWXYZ23456789", // no visually confusable chars (I O L 0 1)
		nil, nil, nil,
	)
	id, content, _ := driver.GenerateIdQuestionAnswer()
	item, err := driver.DrawCaptcha(content)
	if err != nil {
		slog.Warn("[CAPTCHA] draw failed, serving degraded response", "err", err)
		return &CaptchaResult{Required: false}, nil
	}

	ttl := s.cfg.Security.Captcha.TTLSeconds
	if err := s.rdb.Set(ctx, s.key(id), s.digest(content), time.Duration(ttl)*time.Second).Err(); err != nil {
		slog.Warn("[CAPTCHA] redis write failed, serving degraded response", "err", err)
		return &CaptchaResult{Required: false}, nil
	}
	return &CaptchaResult{
		CaptchaID:   id,
		ImageBase64: item.EncodeB64string(),
		ExpiresIn:   ttl,
		Required:    true,
	}, nil
}

// Verify consumes and checks a captcha atomically. Single-use by design:
// calling twice with the same id fails the second time regardless of outcome.
func (s *CaptchaService) Verify(ctx context.Context, captchaID, code string) bool {
	if !s.cfg.Security.Captcha.Enabled {
		return true
	}
	if s.rdb == nil {
		return true
	}
	if captchaID == "" || code == "" {
		return false
	}
	script := `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
redis.call('DEL', KEYS[1])
if v == ARGV[1] then return 1 end
return 0
`
	res, err := s.rdb.Eval(ctx, script, []string{s.key(captchaID)}, s.digest(code)).Int()
	if err != nil {
		slog.Warn("[CAPTCHA] redis error, fail-open", "err", err)
		return true
	}
	return res == 1
}
