package utils

import (
	"crypto/rand"
	"encoding/base64"
	"strings"
)

// randomToken returns an unpadded url-safe base64 token of n random bytes —
// equivalent to Python secrets.token_urlsafe(n).
func RandomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// normalizeEmail applies the same validation as response/auth.py.
func NormalizeEmail(value string) (string, error) {
	email := strings.TrimSpace(strings.ToLower(value))
	if email == "" {
		return "", ErrEmailFormat
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return "", ErrEmailFormat
	}
	local, domain := email[:at], email[at+1:]
	if strings.Contains(local, "@") || !strings.Contains(domain, ".") ||
		strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return "", ErrEmailFormat
	}
	for _, part := range strings.Split(domain, ".") {
		if part == "" {
			return "", ErrEmailFormat
		}
	}
	if strings.ContainsAny(email, " \t\n\r") {
		return "", ErrEmailFormat
	}
	return email, nil
}

// normalizePhone tolerates spaces/dashes and +86/0086 prefixes; must be a
// valid 11-digit mainland mobile number.
func NormalizePhone(value string) (string, error) {
	phone := strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(value))
	switch {
	case strings.HasPrefix(phone, "+86"):
		phone = phone[3:]
	case strings.HasPrefix(phone, "0086"):
		phone = phone[4:]
	}
	if len(phone) != 11 || phone[0] != '1' || phone[1] < '3' || phone[1] > '9' {
		return "", ErrPhoneFormat
	}
	for _, r := range phone {
		if r < '0' || r > '9' {
			return "", ErrPhoneFormat
		}
	}
	return phone, nil
}
