package service

// DeviceAttestor issues and verifies ephemeral, purpose-bound browser
// attestation for public, cost-bearing endpoints (verification-code sending:
// every SMS/email is real money).
//
// Honest scope: a friction layer, NOT a security boundary — the fingerprint
// algorithm ships in public page JS. It stops zero-effort scripted code
// flooding; the existing captcha (human-verification) and per-IP/per-target
// throttles remain the other layers, and they compose.
//
// Privacy: the fingerprint is computed by the page over a per-visit
// challenge (challenge-bound hash → different every visit), so it is NOT a
// persistent cross-site tracking identifier.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

const (
	AttestChallengeTTL = 10 * time.Minute
	AttestTicketTTL    = 15 * time.Minute
)

var AttestTicketTTLSecs = int(AttestTicketTTL.Seconds())

type DeviceAttestor struct {
	secret []byte // boot-random; restarts simply invalidate live tickets
}

func NewDeviceAttestor() *DeviceAttestor {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic("device attestor: crypto/rand unavailable: " + err.Error())
	}
	return &DeviceAttestor{secret: secret}
}

func attestMAC(secret []byte, parts ...string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(strings.Join(parts, "|")))
	return h.Sum(nil)
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// Issue returns a signed, purpose-bound challenge:
// nonce.expiry.purposeB64.mac（用途在签名覆盖内，验签即解出）
func (a *DeviceAttestor) Issue(purpose string, now time.Time) string {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	nonceB64 := b64url(nonce)
	exp := strconv.FormatInt(now.Add(AttestChallengeTTL).Unix(), 10)
	purposeB64 := b64url([]byte(purpose))
	m := attestMAC(a.secret, "challenge", purpose, nonceB64, exp)
	return nonceB64 + "." + exp + "." + purposeB64 + "." + b64url(m)
}

// VerifyChallengeResolve validates signature/expiry and resolves the bound
// purpose. ok=false for any malformed/forged/expired challenge.
func (a *DeviceAttestor) VerifyChallengeResolve(challenge string, now time.Time) (purpose string, ok bool) {
	parts := strings.Split(challenge, ".")
	if len(parts) != 4 {
		return "", false
	}
	nonceB64, expStr, purposeB64, macB64 := parts[0], parts[1], parts[2], parts[3]
	purposeRaw, perr := base64.RawURLEncoding.DecodeString(purposeB64)
	if perr != nil {
		return "", false
	}
	purpose = string(purposeRaw)
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || now.Unix() > exp {
		return "", false
	}
	want := attestMAC(a.secret, "challenge", purpose, nonceB64, expStr)
	got, derr := base64.RawURLEncoding.DecodeString(macB64)
	if derr != nil || len(got) != len(want) {
		return "", false
	}
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return "", false
	}
	// 用途白名单：挑战只能签给烧钱的公开发码端点
	switch purpose {
	case "register_send", "phone_send":
		return purpose, true
	default:
		return "", false
	}
}

// IssueTicket binds (purpose, fingerprint) for AttestTicketTTL.
func (a *DeviceAttestor) IssueTicket(purpose, fingerprint string, now time.Time) string {
	fpHash := sha256.Sum256([]byte(strings.ToLower(fingerprint)))
	fpB64 := b64url(fpHash[:])
	exp := strconv.FormatInt(now.Add(AttestTicketTTL).Unix(), 10)
	m := attestMAC(a.secret, "ticket", purpose, fpB64, exp)
	return fpB64 + "." + exp + "." + b64url(m)
}

// VerifyTicket checks ticket signature/expiry and that it was issued for
// the same fingerprint presented on the gated call.
func (a *DeviceAttestor) VerifyTicket(purpose, fingerprint, ticket string, now time.Time) bool {
	parts := strings.Split(ticket, ".")
	if len(parts) != 3 {
		return false
	}
	fpHash := sha256.Sum256([]byte(strings.ToLower(fingerprint)))
	if parts[0] != b64url(fpHash[:]) {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || now.Unix() > exp {
		return false
	}
	want := attestMAC(a.secret, "ticket", purpose, parts[0], parts[1])
	got, derr := base64.RawURLEncoding.DecodeString(parts[2])
	if derr != nil || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ValidAttestFingerprint — loose format check (16..128 url-safe chars). The
// computation itself is client-trusted (see honest scope above).
func ValidAttestFingerprint(fp string) bool {
	if len(fp) < 16 || len(fp) > 128 {
		return false
	}
	for i := 0; i < len(fp); i++ {
		c := fp[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
