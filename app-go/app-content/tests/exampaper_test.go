package tests

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"strings"
	"testing"

	exampaper "app-content/internal/service/quiz/exampaper"
)

func paperSampleRows() []exampaper.QuestionRow {
	return []exampaper.QuestionRow{
		{QuestionUUID: "q1", QuestionType: "single_choice", QuestionText: "下列说法正确的是？", Options: []string{"A. 甲", "B. 乙", "C. 丙", "D. 丁"}, Answer: "A", Explanation: "甲对"},
		{QuestionUUID: "q2", QuestionType: "single_choice", QuestionText: "第二题", Options: []string{"A. 1", "B. 2", "C. 3", "D. 4"}, Answer: "B"},
		{QuestionUUID: "q3", QuestionType: "single_choice", QuestionText: "第三题", Options: []string{"A. x", "B. y", "C. z", "D. w"}, Answer: "C"},
		{QuestionUUID: "q4", QuestionType: "multi_choice", QuestionText: "多选测试", Options: []string{"A. a", "B. b", "C. c", "D. d"}, Answer: "A、C"},
		{QuestionUUID: "q5", QuestionType: "short_answer", QuestionText: "简答测试", Answer: "要点一、要点二", Explanation: "按点给分"},
	}
}

func TestBuildPaperGroupsAndScores(t *testing.T) {
	paper, err := exampaper.BuildPaper("期末练习", exampaper.StyleGaokao, 100, 0, true, paperSampleRows())
	if err != nil {
		t.Fatalf("BuildPaper: %v", err)
	}
	if paper.Style != exampaper.StyleGaokao || paper.DurationMin != 120 {
		t.Fatalf("style/duration = %s/%d", paper.Style, paper.DurationMin)
	}
	if len(paper.Sections) != 3 {
		t.Fatalf("sections = %d, want 3 (single/multi/short)", len(paper.Sections))
	}
	first := paper.Sections[0]
	if first.Title != "单项选择题" || len(first.Questions) != 3 {
		t.Fatalf("first section = %s (%d questions)", first.Title, len(first.Questions))
	}
	// numbering restarts per section
	if first.Questions[0].Number != 1 || first.Questions[2].Number != 3 {
		t.Fatalf("unexpected numbering in section 1")
	}
	total := 0
	for _, sec := range paper.Sections {
		for _, q := range sec.Questions {
			if q.Score < 1 {
				t.Fatalf("question score < 1: %+v", q)
			}
			total += q.Score
		}
	}
	if total != 100 {
		t.Fatalf("score sum = %d, want 100", total)
	}
	// gaokao header shows section header with uniform per-question score
	if !strings.Contains(first.Header(), "每小题") {
		t.Fatalf("uniform section header missing 每小题: %s", first.Header())
	}
}

func TestBuildPaperValidates(t *testing.T) {
	if _, err := exampaper.BuildPaper("t", "weird", 100, 0, false, paperSampleRows()); err == nil {
		t.Fatal("expected error for unsupported style")
	}
	if _, err := exampaper.BuildPaper("t", exampaper.StyleStandard, 100, 0, false, nil); err == nil {
		t.Fatal("expected error for empty questions")
	}
	if !exampaper.ValidStyle("") || !exampaper.ValidStyle(exampaper.StyleKaoyan) || exampaper.ValidStyle("x") {
		t.Fatal("ValidStyle semantics broken")
	}
}

func TestDocxIsWellFormedZip(t *testing.T) {
	paper, err := exampaper.BuildPaper("高考模拟·数学", exampaper.StyleGaokao, 100, 0, true, paperSampleRows())
	if err != nil {
		t.Fatalf("BuildPaper: %v", err)
	}
	data, err := paper.Docx()
	if err != nil {
		t.Fatalf("Docx: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip open: %v", err)
	}
	want := map[string]bool{
		"[Content_Types].xml":          false,
		"_rels/.rels":                  false,
		"word/document.xml":            false,
		"word/styles.xml":              false,
		"word/_rels/document.xml.rels": false,
	}
	var docXML []byte
	for _, f := range zr.File {
		if _, ok := want[f.Name]; !ok {
			t.Fatalf("unexpected zip entry %s", f.Name)
		}
		want[f.Name] = true
		if f.Name == "word/document.xml" {
			rc, _ := f.Open()
			buf := new(bytes.Buffer)
			_, _ = buf.ReadFrom(rc)
			_ = rc.Close()
			docXML = buf.Bytes()
		}
	}
	for name, seen := range want {
		if !seen {
			t.Fatalf("missing zip entry %s", name)
		}
	}
	// OOXML must be well-formed and carry the exam structure
	if err := xml.Unmarshal(docXML, new(interface{})); err != nil {
		t.Fatalf("document.xml not well-formed: %v", err)
	}
	doc := string(docXML)
	for _, needle := range []string{"高考模拟·数学", "绝密★启用前", "一、单项选择题", "参考答案与解析", "【答案】", "注意事项"} {
		if !strings.Contains(doc, needle) {
			t.Fatalf("document.xml missing %q", needle)
		}
	}
}

func TestDocxStandardStyleOmitsHeader(t *testing.T) {
	paper, err := exampaper.BuildPaper("随堂练习", exampaper.StyleStandard, 100, 45, false, paperSampleRows())
	if err != nil {
		t.Fatalf("BuildPaper: %v", err)
	}
	if paper.DurationMin != 45 {
		t.Fatalf("duration override ignored: %d", paper.DurationMin)
	}
	doc := string(paper.DocumentXML())
	if strings.Contains(doc, "绝密★启用前") || strings.Contains(doc, "参考答案与解析") {
		t.Fatal("standard style must not carry gaokao banner or answer pages")
	}
	if !strings.Contains(doc, "随堂练习") {
		t.Fatal("title missing")
	}
}

func TestChineseNumeral(t *testing.T) {
	cases := map[int]string{1: "一", 4: "四", 10: "十", 11: "十一", 20: "二十", 21: "21"}
	for n, want := range cases {
		if got := exampaper.ChineseNumeral(n); got != want {
			t.Fatalf("exampaper.ChineseNumeral(%d) = %s, want %s", n, got, want)
		}
	}
}
