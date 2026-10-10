package service

// DeviceAttestor issues and verifies ephemeral, share-bound browser
// attestation for the PUBLIC share endpoints.
//
// Honest scope: this is a friction layer, NOT a security boundary — the
// fingerprint algorithm ships in public page JS, so a determined script
// can replicate it or drive a headless browser. It stops zero-effort
// curl/wget mass-downloading and default headless clients. Server health
// under full-scale abuse is guaranteed by the nginx bandwidth/connection
// caps regardless.
//
// Privacy: the fingerprint is computed by the page over a per-visit
// challenge (challenge-bound hash → different every visit), so it is NOT
// a persistent cross-site tracking identifier.

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
	ChallengeTTL = 10 * time.Minute
	TicketTTL    = 15 * time.Minute
)

// TicketTTLSecs — const 表达式不允许方法调用，用 var（只读约定）。
var TicketTTLSecs = int(TicketTTL.Seconds())

type DeviceAttestor struct {
	secret []byte // boot-random; a restart simply invalidates live tickets
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

// Issue returns a signed, token-bound challenge: nonce.expiry.mac
func (a *DeviceAttestor) Issue(shareToken string, now time.Time) string {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	nonceB64 := b64url(nonce)
	exp := strconv.FormatInt(now.Add(ChallengeTTL).Unix(), 10)
	m := attestMAC(a.secret, "challenge", shareToken, nonceB64, exp)
	return nonceB64 + "." + exp + "." + b64url(m)
}

// VerifyChallenge validates signature + expiry + token binding.
func (a *DeviceAttestor) VerifyChallenge(shareToken, challenge string, now time.Time) bool {
	parts := strings.Split(challenge, ".")
	if len(parts) != 3 {
		return false
	}
	nonceB64, expStr, macB64 := parts[0], parts[1], parts[2]
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || now.Unix() > exp {
		return false
	}
	want := attestMAC(a.secret, "challenge", shareToken, nonceB64, expStr)
	got, derr := base64.RawURLEncoding.DecodeString(macB64)
	if derr != nil || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// IssueTicket binds (shareToken, fingerprint) for TicketTTL: fp.expiry.mac
func (a *DeviceAttestor) IssueTicket(shareToken, fingerprint string, now time.Time) string {
	fpHash := sha256.Sum256([]byte(strings.ToLower(fingerprint)))
	fpB64 := b64url(fpHash[:])
	exp := strconv.FormatInt(now.Add(TicketTTL).Unix(), 10)
	m := attestMAC(a.secret, "ticket", shareToken, fpB64, exp)
	return fpB64 + "." + exp + "." + b64url(m)
}

// VerifyTicket checks ticket signature/expiry and that it was issued for
// the same fingerprint presented on the access call.
func (a *DeviceAttestor) VerifyTicket(shareToken, fingerprint, ticket string, now time.Time) bool {
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
	want := attestMAC(a.secret, "ticket", shareToken, parts[0], parts[1])
	got, derr := base64.RawURLEncoding.DecodeString(parts[2])
	if derr != nil || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ValidFingerprint — loose format check (16..128 url-safe chars). The
// computation itself is client-trusted (see honest scope above).
func ValidFingerprint(fp string) bool {
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
