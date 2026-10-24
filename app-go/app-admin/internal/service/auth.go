// Console authentication: bcrypt login against admin_user, DB-backed session
// tokens (admin_session table, sliding 12h), HttpOnly cookie admin_session,
// and a 10-failures-per-minute-per-IP login throttle (same numbers as
// app-pay-admin). Role gate (viewer read-only / admin writes) is applied in
// the router; this service is the credential + session authority.
package service

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"app-admin/internal/model"
	"app-admin/internal/repo"

	"golang.org/x/crypto/bcrypt"
)

const (
	maxFails     = 10
	failWindow   = time.Minute
	defaultTTL   = 12 * time.Hour
	sessionBytes = 32 // -> 64 hex chars, fits session_token varchar(128)
)

var (
	ErrThrottled          = errors.New("too many failed attempts")
	ErrInvalidCredentials = errors.New("invalid credentials")
)

// AuthService owns login / session / password flows + the per-IP throttle.
type AuthService struct {
	ttl time.Duration

	mu          sync.Mutex
	fails       map[string]int
	windowStart time.Time
}

func NewAuthService(ttlMinutes int) *AuthService {
	ttl := defaultTTL
	if ttlMinutes > 0 {
		ttl = time.Duration(ttlMinutes) * time.Minute
	}
	return &AuthService{
		ttl:         ttl,
		fails:       make(map[string]int),
		windowStart: time.Now(),
	}
}

// ── throttle ─────────────────────────────────────────────────────────────

func (a *AuthService) rollLocked() {
	now := time.Now()
	if now.Sub(a.windowStart) >= failWindow {
		a.fails = make(map[string]int)
		a.windowStart = now
	}
}

// Allow reports whether the IP still has failure budget left in the window.
func (a *AuthService) Allow(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollLocked()
	return a.fails[ip] < maxFails
}

// Fail counts one failed credential attempt for the IP.
func (a *AuthService) Fail(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rollLocked()
	a.fails[ip]++
}

// Reset clears the IP failure counter after a success.
func (a *AuthService) Reset(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.fails, ip)
}

// ── login / session / password ───────────────────────────────────────────

// Login verifies credentials and issues a session. On success the failure
// counter resets, last_login_at is stamped, the DB session row is created and
// the account audit log records the login. Empty credentials are a fresh
// visitor, not an attack: they must not burn throttle budget.
func (a *AuthService) Login(username, password, ip, userAgent string) (*model.AdminUser, string, error) {
	if strings.TrimSpace(username) == "" || strings.TrimSpace(password) == "" {
		return nil, "", ErrInvalidCredentials
	}
	if !a.Allow(ip) {
		return nil, "", ErrThrottled
	}
	user, err := repo.GetUserByUsername(username)
	if err != nil {
		return nil, "", err
	}
	if user == nil || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		a.Fail(ip)
		return nil, "", ErrInvalidCredentials
	}
	a.Reset(ip)

	// Housekeeping + fresh session.
	if err := repo.PurgeExpiredSessions(); err != nil {
		return nil, "", err
	}
	token, err := newSessionToken()
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	if err := repo.CreateSession(token, user.ID, ip, userAgent, now.Add(a.ttl)); err != nil {
		return nil, "", err
	}
	if err := repo.TouchLogin(user.ID); err != nil {
		return nil, "", err
	}
	detail := "ip=" + truncateStr(ip, 60)
	if userAgent != "" {
		detail += " ua=" + truncateStr(userAgent, 100)
	}
	_ = repo.RecordAudit(user.Username, "login", "", "", detail)
	return user, token, nil
}

// ResolveSession loads a valid session and slides its expiry forward
// (sliding-authentication: every authenticated request restarts the TTL).
func (a *AuthService) ResolveSession(token string) (*repo.SessionBundle, error) {
	if token == "" {
		return nil, errors.New("empty session token")
	}
	bundle, err := repo.GetSession(token)
	if err != nil {
		return nil, err
	}
	if bundle == nil {
		return nil, nil
	}
	if err := repo.TouchSession(token, time.Now().Add(a.ttl)); err != nil {
		return nil, err
	}
	return bundle, nil
}

// Logout deletes exactly the presented session (so only the current device
// signs out) and records the audit row.
func (a *AuthService) Logout(username, token, ip string) error {
	if token == "" {
		return nil
	}
	if err := repo.DeleteSession(token); err != nil {
		return err
	}
	detail := "ip=" + truncateStr(ip, 60)
	return repo.RecordAudit(username, "logout", "", "", detail)
}

// ChangePassword validates the old password, enforces a minimum length and
// clears must_change_password. Allowed for ANY logged-in account regardless
// of role (the contract explicitly keeps change-password outside the
// admin-only gate).
func (a *AuthService) ChangePassword(user *model.AdminUser, oldPassword, newPassword string) error {
	if len(newPassword) < 8 {
		return repo.ErrWeakPassword
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(oldPassword)) != nil {
		return repo.ErrWrongOldPass
	}
	if err := repo.SetUserPassword(user.ID, newPassword, true); err != nil {
		return err
	}
	return repo.RecordAudit(user.Username, "change_password", "", "", "self password change")
}

// TTLSeconds is used for the cookie Max-Age.
func (a *AuthService) TTLSeconds() int {
	return int(a.ttl.Seconds())
}

func newSessionToken() (string, error) {
	b := make([]byte, sessionBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func truncateStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
