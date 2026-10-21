package pipeline

import (
	"strings"
	"testing"
)

// cjkSentence builds one sentence of n CJK runes (3 bytes each in UTF-8).
func cjkSentence(n int) string { return strings.Repeat("句", n) + "。" }

// TestChunkSplitsLongTextWithOverlap — a long CJK document produces multiple
// chunks, no sentence is lost, and consecutive chunks share overlap content.
func TestChunkSplitsLongTextWithOverlap(t *testing.T) {
	var b strings.Builder
	sentences := make([]string, 0, 60)
	for i := 0; i < 60; i++ {
		s := cjkSentence(10) + "这是第" + itoaForTest(i) + "句。"
		sentences = append(sentences, s)
		b.WriteString(s)
	}
	text := b.String()

	chunks := NewChunker().Chunk(text)
	if len(chunks) < 2 {
		t.Fatalf("long text must produce multiple chunks, got %d", len(chunks))
	}
	joined := ""
	for _, c := range chunks {
		if strings.TrimSpace(c.Text) == "" {
			t.Fatal("empty chunk produced")
		}
		joined += c.Text
	}
	for _, s := range sentences {
		if !strings.Contains(joined, s) {
			t.Fatalf("sentence lost across chunks: %q", s)
		}
	}
	// overlap: the first sentence of chunk[i+1] is a trailing sentence of
	// chunk[i] (tailSentences keeps it for continuity).
	for i := 0; i+1 < len(chunks); i++ {
		first := splitSentences(chunks[i+1].Text)[0]
		if !strings.Contains(chunks[i].Text, first) {
			t.Fatalf("no overlap between chunk %d and %d (missing %q)", i, i+1, first)
		}
	}
}

// itoaForTest — tiny int formatter (keeps the test free of strconv noise).
func itoaForTest(i int) string {
	if i == 0 {
		return "0"
	}
	digits := ""
	for i > 0 {
		digits = string(rune('0'+i%10)) + digits
		i /= 10
	}
	return digits
}

// TestChunkTracksSectionTitles — markdown headings become the SectionTitle
// of the chunks that follow them. Section bodies are long enough to force a
// flush so BOTH sections get their own chunk.
func TestChunkTracksSectionTitles(t *testing.T) {
	var b strings.Builder
	b.WriteString("# 架构\n")
	for i := 0; i < 30; i++ {
		b.WriteString("这是讲架构的句子。")
	}
	b.WriteString("\n# 实现\n")
	for i := 0; i < 30; i++ {
		b.WriteString("这是讲实现的句子。")
	}
	chunks := NewChunker().Chunk(b.String())
	var arch, impl bool
	for _, c := range chunks {
		if c.SectionTitle == "架构" && strings.Contains(c.Text, "讲架构") {
			arch = true
		}
		if c.SectionTitle == "实现" && strings.Contains(c.Text, "讲实现") {
			impl = true
		}
	}
	if !arch || !impl {
		t.Fatalf("section titles not tracked (arch=%v impl=%v)", arch, impl)
	}
}

// TestChunkContentTypeSummaryRule — a short body without a section heading is
// classified as summary; a body under a heading is content.
func TestChunkContentTypeSummaryRule(t *testing.T) {
	chunks := NewChunker().Chunk("短文本。")
	if len(chunks) != 1 || chunks[0].ContentType != "summary" || chunks[0].SectionTitle != "" {
		t.Fatalf("short no-section chunk should be summary: %+v", chunks)
	}
	chunks = NewChunker().Chunk("# 有标题\n短文本。")
	if len(chunks) != 1 || chunks[0].ContentType != "content" || chunks[0].SectionTitle != "有标题" {
		t.Fatalf("heading section must be content: %+v", chunks)
	}
}

// TestChunkDegenerateAndWhitespace — text without any sentence delimiter
// still yields exactly one chunk; whitespace-only input yields none.
func TestChunkDegenerateAndWhitespace(t *testing.T) {
	chunks := NewChunker().Chunk("没有句号的文本也没有换行")
	if len(chunks) != 1 || !strings.Contains(chunks[0].Text, "没有句号") {
		t.Fatalf("degenerate input: %+v", chunks)
	}
	if chunks := NewChunker().Chunk("   "); len(chunks) != 0 {
		t.Fatalf("whitespace-only input must produce no chunks, got %+v", chunks)
	}
}

// TestSplitSentencesDelimiters — every supported delimiter breaks a sentence.
func TestSplitSentencesDelimiters(t *testing.T) {
	got := splitSentences("A。B！C？D；E!F?G;H\nI")
	want := []string{"A。", "B！", "C？", "D；", "E!", "F?", "G;", "H\n", "I"}
	if len(got) != len(want) {
		t.Fatalf("sentences = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sentence %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestEmbeddingTextTitlePrefix — the embedding input carries the title and
// section context, deduplicated, with the body last.
func TestEmbeddingTextTitlePrefix(t *testing.T) {
	cases := []struct {
		title, section, body, want string
	}{
		{"标题", "章节", "正文", "标题 | 章节\n正文"},
		{"标题", "", "正文", "标题\n正文"},
		{"", "", "正文", "正文"},
		{"标题", "标题", "正文", "标题\n正文"}, // duplicate title is not repeated
	}
	for _, c := range cases {
		if got := EmbeddingText(c.body, c.section, c.title); got != c.want {
			t.Fatalf("EmbeddingText(%q,%q,%q) = %q, want %q", c.title, c.section, c.body, got, c.want)
		}
	}
}
