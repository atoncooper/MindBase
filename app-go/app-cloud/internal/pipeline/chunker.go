// Package pipeline implements the Go-native document pipeline: text
// extraction → semantic chunking → gateway embeddings → Milvus cloud_drive
// writes → Mongo full-text, with the same three-store consistency semantics
// as the Python implementation (app/services/doc_parser/vectorize.py).
package pipeline

import (
	"strings"
)

// Chunker splits cleaned text into overlapping, sentence-aligned chunks.
// Parameters mirror the Python SemanticChunker defaults (target 600-900
// chars, overlap 80-150). Chunks are derived data — an exact byte-level
// clone of the Python algorithm is not required, only search-quality parity.
type Chunker struct {
	TargetChars int
	MaxChars    int
	Overlap     int
}

func NewChunker() *Chunker {
	return &Chunker{TargetChars: 750, MaxChars: 900, Overlap: 120}
}

// Chunk is one semantic chunk ready for embedding.
type Chunk struct {
	Text         string // display text
	SectionTitle string // last heading seen before this chunk ("" when none)
	ContentType  string // "content" | "summary"
}

// Chunk splits text into chunks. title is used for the embedding prefix
// (built by EmbeddingText) — the same shape as the Python pipeline.
func (c *Chunker) Chunk(text string) []Chunk {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	sentences := splitSentences(text)
	chunks := make([]Chunk, 0, len(text)/c.TargetChars+1)

	var cur []string
	curLen := 0
	section := ""
	for _, s := range sentences {
		if st, isHeading := headingOf(s); isHeading {
			section = st
		}
		if curLen+len(s) >= c.MaxChars && curLen > 0 {
			chunks = append(chunks, c.makeChunk(cur, section))
			// overlap: keep trailing sentences up to Overlap chars
			tail := c.tailSentences(cur, c.Overlap)
			cur = append(append([]string{}, tail...), s)
			curLen = sumLen(cur)
			continue
		}
		cur = append(cur, s)
		curLen += len(s)
		if curLen >= c.TargetChars {
			chunks = append(chunks, c.makeChunk(cur, section))
			tail := c.tailSentences(cur, c.Overlap)
			cur = append([]string{}, tail...)
			curLen = sumLen(cur)
		}
	}
	if sumLen(cur) > 0 {
		chunks = append(chunks, c.makeChunk(cur, section))
	}
	if len(chunks) == 0 {
		// degenerate input shorter than one sentence boundary
		chunks = append(chunks, Chunk{Text: strings.TrimSpace(text), ContentType: "content"})
	}
	return chunks
}

func (c *Chunker) makeChunk(parts []string, section string) Chunk {
	body := strings.TrimSpace(strings.Join(parts, ""))
	ct := "content"
	if section == "" && len(body) < 80 {
		ct = "summary"
	}
	return Chunk{Text: body, SectionTitle: section, ContentType: ct}
}

// tailSentences returns the trailing sentences totaling ≤ max chars.
func (c *Chunker) tailSentences(parts []string, max int) []string {
	tail := []string{}
	n := 0
	for i := len(parts) - 1; i >= 0; i-- {
		if n+len(parts[i]) > max && len(tail) > 0 {
			break
		}
		tail = append([]string{parts[i]}, tail...)
		n += len(parts[i])
	}
	return tail
}

func sumLen(parts []string) int {
	n := 0
	for _, s := range parts {
		n += len(s)
	}
	return n
}

// splitSentences breaks on CJK/Latin sentence boundaries and newlines.
func splitSentences(text string) []string {
	out := make([]string, 0, 64)
	var cur strings.Builder
	for _, r := range text {
		cur.WriteRune(r)
		switch r {
		case '。', '！', '？', '；', '!', '?', ';', '\n':
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// headingOf detects markdown-style heading lines ("# 标题"), used as section
// markers for chunk metadata (the Python side detects these from the parsed
// heading outline; markdown sources carry them inline in the text).
func headingOf(sentence string) (string, bool) {
	t := strings.TrimSpace(sentence)
	for i := 0; i < 6; i++ {
		if strings.HasPrefix(t, strings.Repeat("#", i+1)+" ") {
			return strings.TrimSpace(t[i+2:]), true
		}
	}
	return "", false
}

// EmbeddingText builds the title-prefixed text sent to the embedding model —
// format parity with the Python _build_embedding_text:
//
//	[page_title] | [video_title] | [section_title]\n[chunk body]
func EmbeddingText(chunk, sectionTitle, title string) string {
	var titles []string
	for _, t := range []string{"", title, sectionTitle} {
		t = strings.TrimSpace(t)
		if t != "" && !contains(titles, t) {
			titles = append(titles, t)
		}
	}
	if len(titles) == 0 {
		return strings.TrimSpace(chunk)
	}
	return strings.Join(titles, " | ") + "\n" + strings.TrimSpace(chunk)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
