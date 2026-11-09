package tests

import (
	"errors"
	"strings"
	"testing"

	service "app-user/internal/service/auth"
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
		{"common", "password1", service.ErrWeakPassword},
		{"email local part", "abc12345", service.ErrWeakPassword},
		{"too long for bcrypt", strings.Repeat("a", 73) + "1", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := service.ValidatePasswordForUser(tc.pw, &email, &phone)
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
