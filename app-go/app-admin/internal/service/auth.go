// Console authentication: bcrypt login against admin_user, DB-backed session
// tokens (admin_session table, sliding 12h expiry), HttpOnly cookie
// admin_session, two independent failed-login budgets (short per IP, longer per
// account) and the audit trail for every login outcome. Device / IP binding of
// live sessions is enforced by the router; this service is the credential +
// session authority. The role gate (viewer read-only / admin writes) also lives
// in the router.
package service

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"app-admin/internal/model"
	"app-admin/internal/repo"

	"golang.org/x/crypto/bcrypt"
)

const (
	// Default per-IP budget: stops one host hammering the login endpoint.
	defaultMaxFailsPerIP = 10
	defaultIPWindow      = time.Minute
	// Default per-account budget: stops credential stuffing spread over many
	// addresses, so the window is intentionally much longer.
	defaultMaxFailsPerAccount = 10
	defaultAccountWindow      = 15 * time.Minute

	defaultTTL   = 12 * time.Hour
	sessionBytes = 32 // -> 64 hex chars, fits session_token varchar(128)

	// devicePrefixLen is how many hex chars of the device fingerprint are used
	// for audit comparison/details; the full hash stays server-side.
	devicePrefixLen = 12
)

var (
	ErrThrottled          = errors.New("too many failed attempts")
	ErrInvalidCredentials = errors.New("invalid credentials")
)

// dummyPasswordHash equalises the credential-check timing for unknown accounts:
// without it, a missing user returns before bcrypt and leaks username existence.
var dummyPasswordHash = func() []byte {
	hash, _ := bcrypt.GenerateFromPassword([]byte("invalid-credential-timing-equalizer"), bcrypt.DefaultCost)
	return hash
}()

// LoginLimits configures the two failed-login budgets. Zero (or negative)
// fields fall back to the defaults.
type LoginLimits struct {
	IPMax                int
	IPWindowSeconds      int
	AccountMax           int
	AccountWindowSeconds int
}

// failBudget is one independent sliding-window failure counter. All access
// happens under AuthService.mu.
type failBudget struct {
	max    int
	window time.Duration
	fails  map[string]int
	start  time.Time
}

func (b *failBudget) roll(now time.Time) {
	if now.Sub(b.start) >= b.window {
		b.fails = make(map[string]int)
		b.start = now
	}
}

func (b *failBudget) allow(key string, now time.Time) bool {
	b.roll(now)
	return b.fails[key] < b.max
}

func (b *failBudget) fail(key string, now time.Time) {
	b.roll(now)
	b.fails[key]++
}

func (b *failBudget) reset(key string) { delete(b.fails, key) }

// AuthService owns login / session / password flows + both failure budgets.
type AuthService struct {
	ttl time.Duration

	mu      sync.Mutex
	ip      failBudget
	account failBudget
}

// NewAuthService keeps the original constructor shape and the default budgets.
func NewAuthService(ttlMinutes int) *AuthService {
	return NewAuthServiceWithLimits(ttlMinutes, LoginLimits{})
}

// NewAuthServiceWithLimits builds the service with explicit login budgets
// (zero values fall back to 10 fails / 60s per IP and 10 fails / 900s per
// account).
func NewAuthServiceWithLimits(ttlMinutes int, lim LoginLimits) *AuthService {
	ttl := defaultTTL
	if ttlMinutes > 0 {
		ttl = time.Duration(ttlMinutes) * time.Minute
	}
	now := time.Now()
	return &AuthService{
		ttl: ttl,
		ip: failBudget{
			max:    positiveOr(lim.IPMax, defaultMaxFailsPerIP),
			window: secondsOr(lim.IPWindowSeconds, defaultIPWindow),
			fails:  make(map[string]int),
			start:  now,
		},
		account: failBudget{
			max:    positiveOr(lim.AccountMax, defaultMaxFailsPerAccount),
			window: secondsOr(lim.AccountWindowSeconds, defaultAccountWindow),
			fails:  make(map[string]int),
			start:  now,
		},
	}
}

func positiveOr(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func secondsOr(value int, fallback time.Duration) time.Duration {
	if value > 0 {
		return time.Duration(value) * time.Second
	}
	return fallback
}

// ── throttle ─────────────────────────────────────────────────────────────

// Allow reports whether the IP still has failure budget left in its window.
func (a *AuthService) Allow(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ip.allow(ip, time.Now())
}

// Fail counts one failed credential attempt for the IP.
func (a *AuthService) Fail(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ip.fail(ip, time.Now())
}

// Reset clears the IP failure counter after a success.
func (a *AuthService) Reset(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ip.reset(ip)
}

// AllowAccount reports whether the account still has failure budget left. The
// account window is independent of the IP window, so rotating addresses does
// not extend the budget of a single account.
func (a *AuthService) AllowAccount(username string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.account.allow(normalizeAccount(username), time.Now())
}

// FailAccount counts one failed credential attempt for the account.
func (a *AuthService) FailAccount(username string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.account.fail(normalizeAccount(username), time.Now())
}

// ResetAccount clears the account failure counter after a success.
func (a *AuthService) ResetAccount(username string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.account.reset(normalizeAccount(username))
}

func normalizeAccount(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// ── login / session / password ───────────────────────────────────────────

// Login verifies credentials and issues a session. Both failure budgets are
// checked first, so a throttled caller learns nothing about the account. On
// failure both budgets advance and the attempt is audited; on success they
// reset, the session row stores the device fingerprint, last_login_at is
// stamped and the ledger records the login plus first-sighting warnings for a
// new device / address. Empty credentials are a fresh visitor, not an attack,
// and never burn budget.
func (a *AuthService) Login(username, password, ip, userAgent, deviceHash string) (*model.AdminUser, string, error) {
	name := strings.TrimSpace(username)
	if name == "" || strings.TrimSpace(password) == "" {
		return nil, "", ErrInvalidCredentials
	}
	if !a.Allow(ip) || !a.AllowAccount(name) {
		return nil, "", ErrThrottled
	}
	user, err := repo.GetUserByUsername(name)
	if err != nil {
		return nil, "", err
	}
	valid := false
	if user == nil {
		// Burn a bcrypt comparison even for unknown usernames (timing equaliser).
		_ = bcrypt.CompareHashAndPassword(dummyPasswordHash, []byte(password))
	} else {
		valid = bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) == nil
	}
	if !valid {
		a.Fail(ip)
		a.FailAccount(name)
		recordAuditBestEffort(truncateRunes(name, 64), "login_failed",
			"ip="+truncateStr(ip, 60)+" device="+devicePrefix(deviceHash)+" reason=invalid_credentials")
		return nil, "", ErrInvalidCredentials
	}
	a.Reset(ip)
	a.ResetAccount(name)

	// Housekeeping + fresh session.
	if err := repo.PurgeExpiredSessions(); err != nil {
		return nil, "", err
	}
	token, err := newSessionToken()
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	if err := repo.CreateSession(token, user.ID, ip, userAgent, deviceHash, now.Add(a.ttl)); err != nil {
		return nil, "", err
	}
	if err := repo.TouchLogin(user.ID); err != nil {
		return nil, "", err
	}
	// First-sighting warnings compare against the PREVIOUS login history, so
	// they are resolved before the current login row is written; the login
	// entry itself closes the sequence.
	a.alertNewDeviceOrIP(user.Username, ip, deviceHash)
	recordAuditBestEffort(user.Username, "login", loginDetail(ip, deviceHash, userAgent))
	return user, token, nil
}

// ResolveSession loads a valid session. The router applies the device / IP
// binding checks before sliding its expiry, so a rejected session is never
// renewed here.
func (a *AuthService) ResolveSession(token string) (*repo.SessionBundle, error) {
	if token == "" {
		return nil, errors.New("empty session token")
	}
	return repo.GetSession(token)
}

// TouchSession slides the session expiry forward (called once the device / IP
// binding checks pass, so a rejected request cannot extend its lifetime).
func (a *AuthService) TouchSession(token string) error {
	return repo.TouchSession(token, time.Now().Add(a.ttl))
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
// clears must_change_password. Allowed for ANY logged-in account regardless of
// role: the admin-only gate covers moderation writes, not password changes.
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

// loginDetail is the ledger shape shared by the history queries: the address
// and the device fingerprint prefix are always present so a later login can be
// compared against them.
func loginDetail(ip, deviceHash, userAgent string) string {
	return "ip=" + truncateStr(ip, 60) +
		" device=" + devicePrefix(deviceHash) +
		" ua=" + truncateStr(userAgent, 100)
}

// alertNewDeviceOrIP writes a first-sighting warning when the account already
// has login history but this device / address never appeared in it. Best
// effort: a missing warning must never block a successful login.
func (a *AuthService) alertNewDeviceOrIP(username, ip, deviceHash string) {
	hasHistory, err := repo.HasAuditDetail(username, "login", "ip=")
	if err != nil || !hasHistory {
		return
	}
	detail := "ip=" + truncateStr(ip, 60) + " device=" + devicePrefix(deviceHash)
	if deviceHash != "" {
		seen, err := repo.HasAuditDetail(username, "login", "device="+devicePrefix(deviceHash)+" ua=")
		if err == nil && !seen {
			recordAuditBestEffort(username, "login_new_device", detail)
		}
	}
	seen, err := repo.HasAuditDetail(username, "login", "ip="+truncateStr(ip, 60)+" device=")
	if err == nil && !seen {
		recordAuditBestEffort(username, "login_new_ip", detail)
	}
}

func recordAuditBestEffort(adminName, action, detail string) {
	if err := repo.RecordAudit(adminName, action, "", "", detail); err != nil {
		slog.Warn("[AUTH] audit write failed", "action", action, "err", err)
	}
}

func devicePrefix(hash string) string {
	if len(hash) > devicePrefixLen {
		return hash[:devicePrefixLen]
	}
	return hash
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
