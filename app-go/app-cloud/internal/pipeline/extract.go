package pipeline

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	pdf "github.com/ledongthuc/pdf"
)

// Sentinel errors that map to vector_status='not_supported' (permanent skip,
// not a retryable failure) — parity with the Python EmptyPdfTextError /
// PdfEncryptedError handling.
var (
	ErrEncryptedPDF = errors.New("PDF is encrypted")
	ErrEmptyPDFText = errors.New("PDF contains no extractable text (scanned/image-only?)")
	ErrNoParser     = errors.New("no parser for this file type")
)

// Heading is a detected document heading (markdown-style outline).
type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

// Parsed is the extraction result.
type Parsed struct {
	Text     string
	Source   string    // parser name persisted to cloud_files.doc_parser
	Headings []Heading // markdown headings (used as chunk section markers)
}

var mdHeadingRe = regexp.MustCompile(`(?m)^(#{1,6})\s+(.+)$`)

// Extract dispatches on mime type / filename. Supported: pdf, docx, xlsx,
// pptx, markdown, html, plain text/csv. Everything else → ErrNoParser.
func Extract(mimeType, filename string, data []byte) (*Parsed, error) {
	m := strings.ToLower(mimeType)
	name := strings.ToLower(filename)

	switch {
	case m == "application/pdf" || strings.HasSuffix(name, ".pdf"):
		return extractPDF(data)
	case m == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		strings.HasSuffix(name, ".docx"):
		return extractDocx(data)
	case m == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		strings.HasSuffix(name, ".xlsx"):
		return extractXlsx(data)
	case m == "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		strings.HasSuffix(name, ".pptx"):
		return extractPptx(data)
	case m == "text/markdown" || m == "text/x-markdown" || strings.HasSuffix(name, ".md"):
		return extractMarkdown(data)
	case m == "text/html" || strings.HasSuffix(name, ".html") || strings.HasSuffix(name, ".htm"):
		return extractHTML(data)
	case strings.HasPrefix(m, "text/") || m == "application/json" ||
		m == "application/xml" || m == "application/x-yaml":
		return &Parsed{Text: string(data), Source: "text"}, nil
	default:
		return nil, ErrNoParser
	}
}

// VectorizableMime reports whether the pipeline can process the file at all
// (parity with the Python is_vectorizable mime whitelist minus videos).
func VectorizableMime(mimeType, filename string) bool {
	_, err := Extract(mimeType, filename, []byte{})
	return err == nil || errors.Is(err, ErrEncryptedPDF) || errors.Is(err, ErrEmptyPDFText)
}

// ── PDF ──────────────────────────────────────────────────────────────

func extractPDF(data []byte) (*Parsed, error) {
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "encrypt") {
			return nil, ErrEncryptedPDF
		}
		return nil, fmt.Errorf("pdf open: %w", err)
	}
	if reader.NumPage() == 0 {
		return nil, ErrEmptyPDFText
	}
	var b strings.Builder
	for i := 1; i <= reader.NumPage(); i++ {
		page := reader.Page(i)
		if page.V.IsNull() {
			continue
		}
		text, err := page.GetPlainText(nil)
		if err != nil {
			continue // best-effort per page
		}
		b.WriteString(text)
		b.WriteString("\n\n")
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return nil, ErrEmptyPDFText
	}
	return &Parsed{Text: out, Source: "pdf"}, nil
}

// ── docx ─────────────────────────────────────────────────────────────

// extractDocx pulls paragraph text from word/document.xml inside the OOXML
// zip. Paragraphs are the semantic unit; tables contribute cell text.
func extractDocx(data []byte) (*Parsed, error) {
	docXML, err := zipEntry(data, "word/document.xml")
	if err != nil {
		return nil, fmt.Errorf("docx: %w", err)
	}
	text := extractOOXMLText(docXML)
	if strings.TrimSpace(text) == "" {
		return nil, ErrEmptyPDFText // no extractable text (image-only doc)
	}
	return &Parsed{Text: text, Source: "docx"}, nil
}

// ── xlsx ─────────────────────────────────────────────────────────────

func extractXlsx(data []byte) (*Parsed, error) {
	shared, err := zipEntry(data, "xl/sharedStrings.xml")
	if err != nil && !errors.Is(err, errZipEntryNotFound) {
		return nil, fmt.Errorf("xlsx: %w", err)
	}
	sheet, err := zipEntry(data, "xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, fmt.Errorf("xlsx: %w", err)
	}
	var b strings.Builder
	if err == nil {
		for _, si := range parseSharedStrings(shared) {
			b.WriteString(si)
			b.WriteString("\n")
		}
	}
	// numeric/inline cells: strip tags from the sheet XML as a coarse fallback
	text := stripXMLTags(string(sheet))
	b.WriteString(text)
	out := strings.TrimSpace(b.String())
	if out == "" {
		return nil, ErrEmptyPDFText
	}
	return &Parsed{Text: out, Source: "xlsx"}, nil
}

// ── pptx ─────────────────────────────────────────────────────────────

func extractPptx(data []byte) (*Parsed, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("pptx: %w", err)
	}
	var b strings.Builder
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, "ppt/slides/slide") || !strings.HasSuffix(f.Name, ".xml") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		xmlData, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		b.WriteString(stripXMLTags(string(xmlData)))
		b.WriteString("\n\n")
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return nil, ErrEmptyPDFText
	}
	return &Parsed{Text: out, Source: "pptx"}, nil
}

// ── markdown / html / text ───────────────────────────────────────────

func extractMarkdown(data []byte) (*Parsed, error) {
	text := string(data)
	headings := []Heading{}
	for _, m := range mdHeadingRe.FindAllStringSubmatch(text, -1) {
		headings = append(headings, Heading{Level: len(m[1]), Text: strings.TrimSpace(m[2])})
	}
	return &Parsed{Text: text, Source: "markdown", Headings: headings}, nil
}

var scriptStyleRe = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)

func extractHTML(data []byte) (*Parsed, error) {
	cleaned := scriptStyleRe.ReplaceAllString(string(data), "")
	return &Parsed{Text: stripXMLTags(cleaned), Source: "html"}, nil
}

// ── OOXML helpers ────────────────────────────────────────────────────

var errZipEntryNotFound = errors.New("zip entry not found")

func zipEntry(data []byte, name string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, errZipEntryNotFound
}

// extractOOXMLText pulls <w:t> runs from OOXML wordprocessing XML, grouping
// paragraphs (<w:p>) into lines.
type wT struct {
	Value string `xml:",chardata"`
}

type wP struct {
	Runs []wT `xml:"t"`
}

type wDocument struct {
	Body struct {
		Paragraphs []wP `xml:"p"`
	} `xml:"body"`
}

func extractOOXMLText(xmlData []byte) string {
	var doc wDocument
	if err := xml.Unmarshal(xmlData, &doc); err != nil {
		return stripXMLTags(string(xmlData))
	}
	var b strings.Builder
	for _, p := range doc.Body.Paragraphs {
		line := strings.TrimSpace(strings.Join(runTexts(p.Runs), ""))
		if line != "" {
			b.WriteString(line)
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func runTexts(runs []wT) []string {
	out := make([]string, 0, len(runs))
	for _, r := range runs {
		out = append(out, r.Value)
	}
	return out
}

// parseSharedStrings extracts <t> values from xl/sharedStrings.xml.
func parseSharedStrings(xmlData []byte) []string {
	type si struct {
		T string `xml:"t"`
	}
	type sst struct {
		SIs []si `xml:"si"`
	}
	var s sst
	if err := xml.Unmarshal(xmlData, &s); err != nil {
		return nil
	}
	out := make([]string, 0, len(s.SIs))
	for _, x := range s.SIs {
		if strings.TrimSpace(x.T) != "" {
			out = append(out, x.T)
		}
	}
	return out
}

var xmlTagRe = regexp.MustCompile(`<[^>]*>`)

func stripXMLTags(s string) string {
	s = xmlTagRe.ReplaceAllString(s, " ")
	// collapse whitespace runs
	s = regexp.MustCompile(`[ \t]+`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\n{3,}`).ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}
