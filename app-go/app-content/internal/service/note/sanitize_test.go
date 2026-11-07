package service

import (
	"strings"
	"testing"
)

// Port of app/test/notes/test_notes_markdown_safety.py — the cases are the
// behaviour contract; do not "fix" Go to differ from them.
func TestSanitizeMarkdown(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain markdown preserved", "# Heading\n\nSome **bold** and *italic* text.", "# Heading\n\nSome **bold** and *italic* text."},
		{"code fence preserved", "```python\nprint('hi')\n```", "```python\nprint('hi')\n```"},
		{"link preserved", "[example](https://example.com)", "[example](https://example.com)"},
		{"image safe url preserved", "![alt](https://example.com/img.png)", "![alt](https://example.com/img.png)"},
		{"image data url preserved (legacy)", "![alt](data:image/png;base64,abc)", "![alt](data:image/png;base64,abc)"},
		{"script stripped", "hello <script>alert('xss')</script> world", "hello  world"},
		{"iframe stripped", `<iframe src="evil"></iframe>clean`, "clean"},
		{"style stripped", "<style>body{color:red}</style>visible", "visible"},
		{"multiple script blocks", "<script>a=1</script>middle<script>b=2</script>end", "middleend"},
		{"raw tag stripped keeps inner text", "hi <b onclick='evil()'>bold</b> there", "hi bold there"},
		{"javascript url replaced", "[click](javascript:alert(1))", "[click](#alert(1))"},
		{"vbscript url replaced", "[x](vbscript:msgbox(1))", "[x](#msgbox(1))"},
		{"file url replaced", "[x](file:///etc/passwd)", "[x](#///etc/passwd)"},
		{"empty input", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SanitizeMarkdown(tc.in)
			if got != tc.want {
				t.Fatalf("SanitizeMarkdown(%q) = %q, want %q", tc.in, got, tc.want)
			}
			for _, bad := range []string{"<script", "<iframe", "<style", "javascript:", "vbscript:", "file:"} {
				if strings.Contains(strings.ToLower(got), bad) {
					t.Errorf("output %q still contains %q", got, bad)
				}
			}
		})
	}
}

// Unterminated opening tag must be left untouched (parity with the Python
// regex, which requires a closing tag to match).
func TestSanitizeUnterminatedBlock(t *testing.T) {
	in := "hello <script>alert(1"
	out := SanitizeMarkdown(in)
	if !strings.Contains(out, "hello") {
		t.Fatalf("expected text preserved, got %q", out)
	}
}

func TestFormatNaiveUTC(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"2026-10-04T12:34:56Z", "2026-10-04T12:34:56"},
		{"2026-10-04T12:34:56.789012Z", "2026-10-04T12:34:56.789012"},
		{"2026-10-04T12:34:56.7Z", "2026-10-04T12:34:56.700000"},
	}
	for _, tc := range cases {
		ts, err := ParseUTC(tc.in)
		if err != nil {
			t.Fatalf("parse %s: %v", tc.in, err)
		}
		if got := FormatNaiveUTC(ts); got != tc.want {
			t.Errorf("FormatNaiveUTC(%s) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDiffRatio(t *testing.T) {
	if DiffRatio("", "") != 0 {
		t.Fatal("empty inputs should yield 0")
	}
	if got := DiffRatio("aaaa", "a"); got < 0.30 {
		t.Errorf("big length delta should exceed threshold, got %v", got)
	}
	if got := DiffRatio("hello", "hello"); got != 0 {
		t.Errorf("identical strings should yield 0, got %v", got)
	}
	if got := DiffRatio("hello", "hxllo"); got <= 0 {
		t.Errorf("one differing char should yield > 0, got %v", got)
	}
}
