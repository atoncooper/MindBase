package config

import "testing"

// P0-2 support: the attest secret parser must accept the documented formats
// and reject everything else at startup (fail loud, never silently degrade).
func TestAttestKeyBytes(t *testing.T) {
	b, err := AttestConfig{Secret: ""}.KeyBytes()
	if err != nil || b != nil {
		t.Fatalf("empty secret => (nil, nil); got %v, err %v", b, err)
	}
	hex64 := "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4"
	hexc := AttestConfig{Secret: hex64}
	b, err = hexc.KeyBytes()
	if err != nil || len(b) != 32 {
		t.Fatalf("64 hex chars => 32 decoded bytes; got len %d, err %v", len(b), err)
	}
	raw := "0123456789abcdef0123456789abcdef0123456789abcdef" // 48 raw chars
	rawc := AttestConfig{Secret: raw}
	b, err = rawc.KeyBytes()
	if err != nil || string(b) != raw {
		t.Fatalf("raw >= 32 bytes used as-is; err %v", err)
	}
	shortc := AttestConfig{Secret: "too-short"}
	if _, err := shortc.KeyBytes(); err == nil {
		t.Fatal("short secret must be rejected")
	}
	nothexc := AttestConfig{Secret: "zzzz" + hex64[4:]} // 64 chars, not valid hex
	b, err = nothexc.KeyBytes()
	if err != nil || len(b) != 64 {
		t.Fatal("non-hex 64 chars are accepted as raw key material (>= 32 bytes rule)")
	}
}
