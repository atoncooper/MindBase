package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidatePasswordForUser(t *testing.T) {
	email := "abc12345@example.com"
	phone := "13800138000"

	cases := []struct {
		name string
		pw   string
		want error
	}{
		{"valid", "Str0ngPass!", nil},
		{"too short", "a1", nil}, // generic strength error
		{"no digit", "PasswordOnly", nil},
		{"common", "password1", ErrWeakPassword},
		{"email local part", "abc12345", ErrWeakPassword},
		{"too long for bcrypt", strings.Repeat("a", 73) + "1", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePasswordForUser(tc.pw, &email, &phone)
			if tc.want != nil {
				if !errors.Is(err, tc.want) {
					t.Fatalf("want %v, got %v", tc.want, err)
				}
				return
			}
			if tc.name == "valid" {
				if err != nil {
					t.Fatalf("valid password rejected: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("case %q unexpectedly accepted", tc.name)
			}
		})
	}
}
