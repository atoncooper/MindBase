package service

import (
	"errors"
	"strings"
)

// ErrWeakPassword rejects passwords from the common-password blacklist or
// trivial variants of the account's own identifiers.
var ErrWeakPassword = errors.New("密码过于常见，请更换更复杂的密码")

// bcrypt only consumes the first 72 bytes; reject longer inputs so two
// different passwords can never map to the same hash.
const maxPasswordBytes = 72

// commonPasswords is a small local blacklist (lowercase) for the most abused
// passwords that still satisfy the letter+digit policy. It is deliberately
// dependency-free; a full breach-list service can be layered on later.
var commonPasswords = map[string]struct{}{
	"password1": {}, "password12": {}, "password123": {}, "passw0rd": {},
	"qwerty123": {}, "qwerty1234": {}, "abc12345": {}, "abcd1234": {},
	"12345678a": {}, "123456789a": {}, "a1234567": {}, "1qaz2wsx": {},
	"1q2w3e4r": {}, "zaq12wsx": {}, "iloveyou1": {}, "welcome1": {},
	"welcome123": {}, "admin123": {}, "admin1234": {}, "root1234": {},
	"letmein1": {}, "letmein123": {}, "monkey123": {}, "dragon123": {},
	"sunshine1": {}, "princess1": {}, "football1": {}, "baseball1": {},
	"master123": {}, "shadow123": {}, "superman1": {}, "starwars1": {},
	"trustno1": {}, "whatever1": {}, "hello123": {}, "freedom1": {},
	"changeme1": {}, "test1234": {}, "test12345": {}, "guest1234": {},
	"qq123456": {}, "wx123456": {}, "bilibili1": {}, "mindbase1": {},
}

// validatePasswordForUser applies the generic strength policy, the common
// password blacklist and "password equals your own email/phone" checks.
func validatePasswordForUser(password string, email, phone *string) error {
	if err := validatePasswordStrength(password); err != nil {
		return err
	}
	lower := strings.ToLower(password)
	if _, ok := commonPasswords[lower]; ok {
		return ErrWeakPassword
	}
	if email != nil && *email != "" {
		mail := strings.ToLower(strings.TrimSpace(*email))
		local := mail
		if i := strings.IndexByte(mail, '@'); i > 0 {
			local = mail[:i]
		}
		if lower == mail || lower == local {
			return ErrWeakPassword
		}
	}
	if phone != nil && *phone != "" && password == strings.TrimSpace(*phone) {
		return ErrWeakPassword
	}
	return nil
}

// maskEmail / maskPhone keep audit details useful without storing full contact
// identifiers in the security-event table.
func maskEmail(email string) string {
	email = strings.TrimSpace(email)
	at := strings.LastIndexByte(email, '@')
	if at <= 0 {
		return "***"
	}
	local := email[:at]
	if len(local) <= 1 {
		return "***" + email[at:]
	}
	return local[:1] + "***" + email[at:]
}
