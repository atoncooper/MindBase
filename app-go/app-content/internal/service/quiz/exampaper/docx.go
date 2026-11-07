package exampaper

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"regexp"
	"strings"
)

// xmlEsc escapes text nodes for OOXML.
var xmlEsc = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	"\"", "&quot;",
	"'", "&apos;",
)

// run renders one w:r with optional run properties.
func run(text string, props string) string {
	rpr := ""
	if props != "" {
		rpr = "<w:rPr>" + props + "</w:rPr>"
	}
	return "<w:r>" + rpr + "<w:t xml:space=\"preserve\">" + xmlEsc.Replace(text) + "</w:t></w:r>"
}

// Run props (fonts carry w:eastAsia so CJK renders in the intended face).
func fontProps(eastAsia string, halfPoints int, bold bool) string {
	var b strings.Builder
	b.WriteString("<w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"" + eastAsia + "\"/>")
	if bold {
		b.WriteString("<w:b/>")
	}
	fmt.Fprintf(&b, "<w:sz w:val=\"%d\"/><w:szCs w:val=\"%d\"/>", halfPoints, halfPoints)
	return b.String()
}

// para renders one w:p. pPr carries alignment/spacing/indent; runs carry text.
func para(pPr string, runsXML string) string {
	pp := ""
	if pPr != "" {
		pp = "<w:pPr>" + pPr + "</w:pPr>"
	}
	return "<w:p>" + pp + runsXML + "</w:p>"
}

const (
	prCenter    = "<w:jc w:val=\"center\"/>"
	prJust      = "<w:jc w:val=\"both\"/>"
	prSpacing   = "<w:spacing w:before=\"60\" w:after=\"60\" w:line=\"360\" w:lineRule=\"auto\"/>"
	prSpacingLo = "<w:spacing w:before=\"40\" w:after=\"40\" w:line=\"312\" w:lineRule=\"auto\"/>"
	prIndent    = "<w:ind w:firstLineChars=\"200\" w:firstLine=\"420\"/>"
	prRight2    = "<w:ind w:left=\"420\"/>"
	// bottom-bordered blank line: writing space for subjective questions
	prBlankLine = "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"1\" w:color=\"000000\"/></w:pBdr><w:spacing w:before=\"240\" w:after=\"240\"/>"
)

func pageBreak() string {
	return para("", "<w:r><w:br w:type=\"page\"/></w:r>")
}

// ── 选择题选项自适应排版 ────────────────────────────────────────────
// 短选项（去标签后最长 ≤ maxShortOptionChars 字）→ 2×2 矩阵（每行两个，
// 中点制表位对齐）；长选项 → 4×1 竖排。与前端 A4 预览（exam-paper.ts）同一规则。
const (
	maxShortOptionChars = 10
	// A4 内容宽 ≈ 8917 twips，中点制表位取一半
	prTabsMid = "<w:tabs><w:tab w:val=\"left\" w:pos=\"4460\"/></w:tabs>"
)

var optionLabelRe = regexp.MustCompile(`^\s*[A-Za-z](?:[.．、\s]+)`)

// maxOptionTextLen returns the longest option body length (runes, label stripped).
func maxOptionTextLen(opts []string) int {
	max := 0
	for _, o := range opts {
		n := len([]rune(optionLabelRe.ReplaceAllString(strings.TrimSpace(o), "")))
		if n > max {
			max = n
		}
	}
	return max
}

// optionRuns renders one matrix row: left option + tab + right option.
func optionRuns(left, right, props string) string {
	rpr := "<w:rPr>" + props + "</w:rPr>"
	return "<w:r>" + rpr + "<w:t xml:space=\"preserve\">" + xmlEsc.Replace(left) + "</w:t></w:r>" +
		"<w:r>" + rpr + "<w:tab/></w:r>" +
		"<w:r>" + rpr + "<w:t xml:space=\"preserve\">" + xmlEsc.Replace(right) + "</w:t></w:r>"
}

// writeOptions emits the option block with the adaptive layout.
func writeOptions(b *strings.Builder, opts []string) {
	props := fontProps("宋体", 21, false)
	ppr := prJust + prSpacingLo + prRight2
	if maxOptionTextLen(opts) <= maxShortOptionChars {
		// 短选项 → 2×2 矩阵
		for i := 0; i < len(opts); i += 2 {
			if i+1 >= len(opts) {
				b.WriteString(para(ppr, run(opts[i], props)))
				continue
			}
			b.WriteString(para(ppr+prTabsMid, optionRuns(opts[i], opts[i+1], props)))
		}
		return
	}
	// 长选项 → 竖排
	for _, opt := range opts {
		b.WriteString(para(ppr, run(opt, props)))
	}
}

// sectPr: A4 portrait, ~2.5cm margins.
const sectPrXML = "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>" +
	"<w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1571\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/>" +
	"</w:sectPr>"

const contentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const relsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const documentRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>
<w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault>
</w:docDefaults>
</w:styles>`

// notices returns the per-style 注意事项 lines.
func notices(style string) []string {
	switch style {
	case StyleGaokao:
		return []string{
			"1. 答题前，考生务必将自己的姓名、准考证号填写在答题卡上。",
			"2. 回答选择题时，选出每小题答案后，用铅笔把答题卡上对应题目的答案标号涂黑。如需改动，用橡皮擦干净后再选涂其他答案标号。",
			"3. 回答非选择题时，将答案写在答题卡上。写在本试卷上无效。",
			"4. 考试结束后，将本试卷和答题卡一并交回。",
		}
	case StyleKaoyan:
		return []string{
			"1. 考生须严格遵守考场规则，考生在答题前，须将自己的姓名、考生编号填写在答题卡（纸）上。",
			"2. 答案须书写在答题卡（纸）的相应位置，书写在试题册上的答案无效。",
			"3. 选择题须用 2B 铅笔将答题卡上对应题目的答案标号按要求涂黑；非选择题须用黑色字迹签字笔作答。",
			"4. 考试结束后，将答题卡（纸）和试题册一并交回。",
		}
	default:
		return []string{
			"1. 请将姓名等信息填写在试卷指定位置，答案写在对应题目下方或答题纸。",
			"2. 选择题从选项中选出符合题意的答案；简答与论述题按要点作答。",
			"3. 考试结束后，将试卷一并交回。",
		}
	}
}

// headerBlock renders the per-style paper header.
func (p *Paper) headerBlock() string {
	var b strings.Builder
	switch p.Style {
	case StyleGaokao:
		b.WriteString(para(prCenter, run("绝密★启用前", fontProps("黑体", 18, true))))
		b.WriteString(para(prCenter, run(p.Title, fontProps("黑体", 32, true))))
		b.WriteString(para(prCenter, run(fmt.Sprintf("考试时间：%d 分钟　　满分：%d 分", p.DurationMin, p.TotalScore), fontProps("宋体", 21, false))))
	case StyleKaoyan:
		b.WriteString(para(prCenter, run(fmt.Sprintf("%d 年全国硕士研究生招生考试", p.GeneratedAt.Year()), fontProps("黑体", 24, true))))
		b.WriteString(para(prCenter, run(p.Title, fontProps("黑体", 32, true))))
		b.WriteString(para(prCenter, run(fmt.Sprintf("（满分 %d 分，考试时间 %d 分钟）", p.TotalScore, p.DurationMin), fontProps("宋体", 21, false))))
	default:
		b.WriteString(para(prCenter, run(p.Title, fontProps("黑体", 32, true))))
		b.WriteString(para(prCenter, run(fmt.Sprintf("考试时间：%d 分钟　　满分：%d 分", p.DurationMin, p.TotalScore), fontProps("宋体", 21, false))))
	}
	if p.Style != StyleStandard {
		b.WriteString(para(prCenter, run("姓名：____________　准考证号：____________　考场：________　座位号：________", fontProps("宋体", 21, false))))
	}
	// 注意事项
	b.WriteString(para(prJust, run("注意事项：", fontProps("黑体", 21, true))))
	for _, n := range notices(p.Style) {
		b.WriteString(para(prJust+prSpacingLo, run(n, fontProps("宋体", 18, false))))
	}
	return b.String()
}

// DocumentXML renders the paper body into the OOXML document part.
func (p *Paper) DocumentXML() []byte {
	var b strings.Builder
	b.WriteString("<w:body>")
	// header
	b.WriteString(p.headerBlock())
	// sections + questions
	for _, sec := range p.Sections {
		b.WriteString(para(prJust+prSpacing, run(sec.Header(), fontProps("黑体", 24, true))))
		for _, q := range sec.Questions {
			stem := fmt.Sprintf("%d.（%d 分）%s", q.Number, q.Score, q.Row.QuestionText)
			if q.Row.QuestionType == "multi_choice" && !strings.Contains(q.Row.QuestionText, "多选") {
				stem = fmt.Sprintf("%d.（%d 分，多选）%s", q.Number, q.Score, q.Row.QuestionText)
			}
			b.WriteString(para(prJust+prSpacing+prIndent, run(stem, fontProps("宋体", 21, false))))
			writeOptions(&b, q.Row.Options)
			// 主观题作答区（下划线空行）
			switch q.Row.QuestionType {
			case "short_answer":
				for i := 0; i < 3; i++ {
					b.WriteString(para(prBlankLine, ""))
				}
			case "essay":
				for i := 0; i < 8; i++ {
					b.WriteString(para(prBlankLine, ""))
				}
			}
		}
	}

	// 参考答案与解析（独立起页）
	if p.IncludeAnswers {
		b.WriteString(pageBreak())
		b.WriteString(para(prCenter, run("参考答案与解析", fontProps("黑体", 28, true))))
		for _, sec := range p.Sections {
			if len(sec.Questions) == 0 {
				continue
			}
			hasAnswer := false
			for _, q := range sec.Questions {
				if q.Row.Answer != "" || q.Row.Explanation != "" {
					hasAnswer = true
					break
				}
			}
			if !hasAnswer {
				continue
			}
			b.WriteString(para(prJust+prSpacing, run(sec.TitleOnly(), fontProps("黑体", 24, true))))
			for _, q := range sec.Questions {
				if q.Row.Answer == "" && q.Row.Explanation == "" {
					continue
				}
				if q.Row.Answer != "" {
					b.WriteString(para(prJust+prSpacingLo+prRight2, run(fmt.Sprintf("%d. 【答案】%s", q.Number, q.Row.Answer), fontProps("宋体", 21, false))))
				} else {
					b.WriteString(para(prJust+prSpacingLo+prRight2, run(fmt.Sprintf("%d.", q.Number), fontProps("宋体", 21, false))))
				}
				if q.Row.Explanation != "" {
					b.WriteString(para(prJust+prSpacingLo+prRight2, run("【解析】"+q.Row.Explanation, fontProps("宋体", 21, false))))
				}
			}
		}
	}

	b.WriteString(sectPrXML)
	b.WriteString("</w:body>")

	doc := "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
		"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">" +
		b.String() + "</w:document>"
	return []byte(doc)
}

// Docx packages the paper into a .docx (zip of OOXML parts).
func (p *Paper) Docx() ([]byte, error) {
	docXML := p.DocumentXML()
	// well-formedness self-check: the hand-rolled XML must always parse
	if err := xml.Unmarshal(docXML, new(interface{})); err != nil {
		return nil, fmt.Errorf("exampaper: generated document.xml is not well-formed: %w", err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	parts := []struct {
		name string
		data []byte
	}{
		{"[Content_Types].xml", []byte(contentTypesXML)},
		{"_rels/.rels", []byte(relsXML)},
		{"word/_rels/document.xml.rels", []byte(documentRelsXML)},
		{"word/styles.xml", []byte(stylesXML)},
		{"word/document.xml", docXML},
	}
	for _, part := range parts {
		w, err := zw.Create(part.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(part.data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
