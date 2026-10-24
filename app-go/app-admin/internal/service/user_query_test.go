package service

import "testing"

// The console infers the lookup mode with the same precedence; the backend must
// validate both the explicit mode and the inferred one (defense in depth).
func TestNormalizeUserQuery(t *testing.T) {
	// uid: numeric, no leading zero.
	if q, mode, err := normalizeUserQuery("233830818118639616", ""); err != nil || mode != UserQueryUID || q.Mode != "uid" {
		t.Fatalf("uid inference failed: q=%+v mode=%s err=%v", q, mode, err)
	}
	if q, mode, err := normalizeUserQuery(" 233830818118639616 ", "uid"); err != nil || mode != UserQueryUID || q.Value != "233830818118639616" {
		t.Fatalf("explicit uid failed: q=%+v mode=%s err=%v", q, mode, err)
	}
	// phone: exactly 11 digits, 1[3-9].
	if q, mode, err := normalizeUserQuery("13800138000", ""); err != nil || mode != UserQueryPhone || q.Mode != "phone" {
		t.Fatalf("phone inference failed: q=%+v mode=%s err=%v", q, mode, err)
	}
	if q, mode, err := normalizeUserQuery("13800138000", "phone"); err != nil || mode != UserQueryPhone || q.Value != "13800138000" {
		t.Fatalf("explicit phone failed: q=%+v mode=%s err=%v", q, mode, err)
	}
	// email: contains @, exact shape.
	if q, mode, err := normalizeUserQuery("zatoncooper@gmail.com", ""); err != nil || mode != UserQueryEmail || q.Mode != "email" {
		t.Fatalf("email inference failed: q=%+v mode=%s err=%v", q, mode, err)
	}
	if _, mode, err := normalizeUserQuery("zatoncooper@gmail.com", "email"); err != nil || mode != UserQueryEmail {
		t.Fatalf("explicit email failed: mode=%s err=%v", mode, err)
	}
	// empty q + empty mode = list all.
	if q, mode, err := normalizeUserQuery("  ", ""); err != nil || mode != "" || q.Value != "" {
		t.Fatalf("empty query failed: q=%+v mode=%s err=%v", q, mode, err)
	}
}

func TestNormalizeUserQueryRejects(t *testing.T) {
	cases := []struct {
		value, mode string
	}{
		{"13800138000", "uid"},          // inferred phone, explicit uid
		{"233830818118639616", "phone"}, // inferred uid, explicit phone
		{"zatoncooper@gmail.com", "phone"},
		{"not-an-email@", ""},    // inferred email but malformed
		{"12345678901", "phone"}, // 11 digits but prefix 12
		{"abc", ""},              // no valid mode
		{"", "email"},            // mode without q
		{"13800138000", "nickname"},
	}
	for _, tc := range cases {
		if _, _, err := normalizeUserQuery(tc.value, tc.mode); err == nil {
			t.Fatalf("normalizeUserQuery(%q, %q) must fail", tc.value, tc.mode)
		}
	}
}
