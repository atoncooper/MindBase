package service

import (
	"strings"
	"testing"
)

// UUIDv7 wire format: 8-4-4-4-12 hex, version nibble 7, RFC-4122 variant.
func TestUUID7Layout(t *testing.T) {
	id, err := uuid7()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(id, "-")
	if len(parts) != 5 ||
		len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 ||
		len(parts[3]) != 4 || len(parts[4]) != 12 {
		t.Fatalf("malformed uuid7: %q", id)
	}
	if parts[2][0] != '7' {
		t.Fatalf("version nibble = %c, want 7", parts[2][0])
	}
	if v := parts[3][0]; v != '8' && v != '9' && v != 'a' && v != 'b' {
		t.Fatalf("variant = %c, want 10xx (8..b)", v)
	}
}

func TestUUID7Unique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id, err := uuid7()
		if err != nil {
			t.Fatal(err)
		}
		if seen[id] {
			t.Fatalf("duplicate uuid7: %s", id)
		}
		seen[id] = true
	}
}
