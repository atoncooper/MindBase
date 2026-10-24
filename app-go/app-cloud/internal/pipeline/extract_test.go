package pipeline

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"
	"testing"
)

// ── helpers: in-memory OOXML zip construction ─────────────────────────

type repeatReader struct {
	b byte
	n int64
}

func (r *repeatReader) Read(p []byte) (int, error) {
	if r.n <= 0 {
		return 0, io.EOF
	}
	n := int64(len(p))
	if n > r.n {
		n = r.n
	}
	for i := int64(0); i < n; i++ {
		p[i] = r.b
	}
	r.n -= n
	return int(n), nil
}

// buildZip writes an in-memory zip with the given entries (name → content).
func buildZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(w, strings.NewReader(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const docMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const xlsMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const pptMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

// ── docx ──────────────────────────────────────────────────────────────

func TestExtractDocxJoinsRunsAndParagraphs(t *testing.T) {
	data := buildZip(t, map[string]string{
		"word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>" +
			"<w:p><w:r><w:t>第一段</w:t><w:t>内容</w:t></w:r></w:p>" +
			"<w:p><w:r><w:t>第二段</w:t></w:r></w:p>" +
			"</w:body></w:document>",
	})
	p, err := Extract(docMime, "a.docx", data)
	if err != nil {
		t.Fatalf("extract docx: %v", err)
	}
	if p.Source != "docx" {
		t.Fatalf("source = %q, want docx", p.Source)
	}
	if !strings.Contains(p.Text, "第一段内容") || !strings.Contains(p.Text, "第二段") {
		t.Fatalf("paragraph text lost: %q", p.Text)
	}
	if !strings.Contains(p.Text, "\n") {
		t.Fatalf("paragraphs must be separated by newlines: %q", p.Text)
	}
}

func TestExtractDocxEmptyBodyIsPermanentSkip(t *testing.T) {
	data := buildZip(t, map[string]string{
		"word/document.xml": "<w:document><w:body></w:body></w:document>",
	})
	_, err := Extract(docMime, "a.docx", data)
	if !errors.Is(err, ErrEmptyPDFText) {
		t.Fatalf("want ErrEmptyPDFText, got %v", err)
	}
}

// Regression (found by this suite): wP must use the r>t path syntax — a bare
// "t" tag only matches DIRECT children, so standard documents (runs nested in
// w:r) extracted as empty and were misclassified as image-only.
func TestOoxmlRunMatchingIsNestedAware(t *testing.T) {
	cases := []string{
		"<w:document><w:body><w:p><w:r><w:t>nested-nodecl</w:t></w:r></w:p></w:body></w:document>",
		"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>nested-decl</w:t></w:r></w:p></w:body></w:document>",
	}
	for i, x := range cases {
		var doc wDocument
		if err := xml.Unmarshal([]byte(x), &doc); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		texts := make([]string, 0, len(doc.Body.Paragraphs))
		for _, pp := range doc.Body.Paragraphs {
			texts = append(texts, strings.Join(runTexts(pp.Runs), ""))
		}
		joined := strings.Join(texts, "")
		want := []string{"nested-nodecl", "nested-decl"}[i]
		if !strings.Contains(joined, want) {
			t.Fatalf("case %d: run text lost with r>t path syntax (missing %q): %q", i, want, joined)
		}
	}
}

// ── xlsx ──────────────────────────────────────────────────────────────

func TestExtractXlsxReadsSharedStringsAndSheet(t *testing.T) {
	// Real-world xlsx: shared-string cells (t="s" + index), numeric cells, and
	// inline strings. Some editors encode non-ASCII as numeric character
	// references (&#NNNN;) — the reviewed text must decode them.
	data := buildZip(t, map[string]string{
		"xl/sharedStrings.xml": "<sst><si><t>共享字符串甲</t></si><si><t>乙</t></si></sst>",
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData><row>` +
			`<c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>123</v></c>` +
			`<c t="inlineStr"><is><t>&#22995;&#21517;</t></is></c>` +
			`</row></sheetData></worksheet>`,
	})
	p, err := Extract(xlsMime, "a.xlsx", data)
	if err != nil {
		t.Fatalf("extract xlsx: %v", err)
	}
	if p.Source != "xlsx" {
		t.Fatalf("source = %q", p.Source)
	}
	for _, want := range []string{"共享字符串甲", "乙", "123", "姓名"} {
		if !strings.Contains(p.Text, want) {
			t.Fatalf("xlsx text lost %q: %q", want, p.Text)
		}
	}
	if strings.Contains(p.Text, "&#") {
		t.Fatalf("xlsx text kept XML entities: %q", p.Text)
	}
}

// ── pptx ──────────────────────────────────────────────────────────────

func TestExtractPptxReadsSlides(t *testing.T) {
	data := buildZip(t, map[string]string{
		"ppt/slides/slide1.xml":         "<p:sld><p:txBody><a:p><a:r><a:t>第一页要点</a:t></a:r></a:p></p:txBody></p:sld>",
		"ppt/slides/slide2.xml":         "<p:sld><p:txBody><a:p><a:r><a:t>第二页要点</a:t></a:r></a:p></p:txBody></p:sld>",
		"ppt/notesSlides/notASlide.xml": "<p:notes>不应出现</p:notes>",
	})
	p, err := Extract(pptMime, "a.pptx", data)
	if err != nil {
		t.Fatalf("extract pptx: %v", err)
	}
	if !strings.Contains(p.Text, "第一页要点") || !strings.Contains(p.Text, "第二页要点") {
		t.Fatalf("slide text lost: %q", p.Text)
	}
	if strings.Contains(p.Text, "不应出现") {
		t.Fatal("non-slide entry must not leak into the text")
	}
}

// ── markdown / html / plain ───────────────────────────────────────────

func TestExtractMarkdownDetectsHeadings(t *testing.T) {
	p, err := Extract("text/markdown", "a.md", []byte("# 架构\n正文一\n## 实现\n正文二"))
	if err != nil {
		t.Fatal(err)
	}
	if p.Source != "markdown" {
		t.Fatalf("source = %q", p.Source)
	}
	if len(p.Headings) != 2 || p.Headings[0].Level != 1 || p.Headings[0].Text != "架构" ||
		p.Headings[1].Level != 2 || p.Headings[1].Text != "实现" {
		t.Fatalf("headings = %+v", p.Headings)
	}
}

func TestExtractHTMLStripsScriptStyleAndTags(t *testing.T) {
	in := "<html><head><style>.x{color:red}</style>" +
		"<script>alert(1)</script></head><body><p>hello 世界</p><b>加粗</b></body></html>"
	p, err := Extract("text/html", "a.html", []byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(p.Text, "alert") || strings.Contains(p.Text, "color") ||
		strings.Contains(p.Text, "<") {
		t.Fatalf("script/style/tags must be stripped: %q", p.Text)
	}
	if !strings.Contains(p.Text, "hello") || !strings.Contains(p.Text, "加粗") {
		t.Fatalf("visible text lost: %q", p.Text)
	}
}

func TestExtractPlainAndNoParser(t *testing.T) {
	p, err := Extract("text/plain", "a.txt", []byte("plain 正文"))
	if err != nil || p.Source != "text" || !strings.Contains(p.Text, "plain 正文") {
		t.Fatalf("plain text passthrough broken: %v %+v", err, p)
	}
	if _, err := Extract("application/zip", "a.zip", []byte("PK")); !errors.Is(err, ErrNoParser) {
		t.Fatalf("zip has no parser, want ErrNoParser, got %v", err)
	}
}

// ── zip bomb guard (size-cap regression) ─────────────────────────────

func TestExtractDocxZipBombGuard(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "word/document.xml", Method: zip.Deflate})
	if err != nil {
		t.Fatal(err)
	}
	// 66 MB of compressible content decompresses past the 64 MB entry cap.
	if _, err := io.CopyN(w, &repeatReader{b: 'A', n: 66 << 20}, 66<<20); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if len(buf.Bytes()) > 10<<20 {
		t.Fatalf("test setup: compressed bomb should be small, got %d", len(buf.Bytes()))
	}
	_, err = Extract(docMime, "bomb.docx", buf.Bytes())
	if !errors.Is(err, ErrZipEntryTooLarge) {
		t.Fatalf("want ErrZipEntryTooLarge, got %v", err)
	}
}
