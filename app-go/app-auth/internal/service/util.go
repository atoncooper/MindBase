package service

import (
	"crypto/rand"
	"encoding/base64"
	"strings"
)

// randomToken returns an unpadded url-safe base64 token of n random bytes —
// equivalent to Python secrets.token_urlsafe(n).
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// NormalizeEmailExported applies the same validation as response/auth.py.
func NormalizeEmailExported(value string) (string, error) { return normalizeEmail(value) }

// NormalizePhoneExported normalizes/validates a mainland mobile number.
func NormalizePhoneExported(value string) (string, error) { return normalizePhone(value) }

// normalizeEmail applies the same validation as response/auth.py.
func normalizeEmail(value string) (string, error) {
	email := strings.TrimSpace(strings.ToLower(value))
	if email == "" {
		return "", errEmailFormat
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return "", errEmailFormat
	}
	local, domain := email[:at], email[at+1:]
	if strings.Contains(local, "@") || !strings.Contains(domain, ".") ||
		strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return "", errEmailFormat
	}
	for _, part := range strings.Split(domain, ".") {
		if part == "" {
			return "", errEmailFormat
		}
	}
	if strings.ContainsAny(email, " \t\n\r") {
		return "", errEmailFormat
	}
	return email, nil
}

// normalizePhone tolerates spaces/dashes and +86/0086 prefixes; must be a
// valid 11-digit mainland mobile number.
func normalizePhone(value string) (string, error) {
	phone := strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(value))
	switch {
	case strings.HasPrefix(phone, "+86"):
		phone = phone[3:]
	case strings.HasPrefix(phone, "0086"):
		phone = phone[4:]
	}
	if len(phone) != 11 || phone[0] != '1' || phone[1] < '3' || phone[1] > '9' {
		return "", errPhoneFormat
	}
	for _, r := range phone {
		if r < '0' || r > '9' {
			return "", errPhoneFormat
		}
	}
	return phone, nil
}
