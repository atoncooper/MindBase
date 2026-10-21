package repo

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// truncateErr must bound the byte length without splitting a multi-byte rune
// (last_error is varchar(500); Chinese error messages are common).
func TestTruncateErrRespectsRuneBoundary(t *testing.T) {
	long := strings.Repeat("错", 250) // 750 bytes of 3-byte runes
	got := truncateErr(long)
	if len(got) > 500 {
		t.Fatalf("truncated to %d bytes, want <= 500", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatal("truncation split a multi-byte rune")
	}
	if !strings.HasPrefix(long, got) {
		t.Fatal("truncated value must be a strict prefix of the input")
	}
}

func TestTruncateErrShortPassthrough(t *testing.T) {
	if got := truncateErr("短错误"); got != "短错误" {
		t.Fatalf("got %q", got)
	}
	if got := truncateErr(""); got != "" {
		t.Fatalf("empty passthrough: %q", got)
	}
}
