// Package exampaper renders a quiz set as an exam-style paper (试卷) for
// printing. The docx face is a minimal WordprocessingML writer built on the
// standard library only (archive/zip + hand-rolled OOXML) — no third-party
// dependencies, mirroring the service's dependency posture.
package exampaper

import (
	"fmt"
	"strings"
	"time"
)

// Paper styles (卷面风格).
const (
	StyleStandard = "standard"
	StyleGaokao   = "gaokao"
	StyleKaoyan   = "kaoyan"
)

// ValidStyle reports whether the requested paper style is supported.
func ValidStyle(style string) bool {
	switch style {
	case "", StyleStandard, StyleGaokao, StyleKaoyan:
		return true
	}
	return false
}

// NormalizeStyle maps "" to the default style.
func NormalizeStyle(style string) string {
	if style == "" {
		return StyleStandard
	}
	return style
}

// QuestionRow is one storage-shape question entering the paper.
type QuestionRow struct {
	QuestionUUID string
	QuestionType string
	QuestionText string
	Options      []string
	Answer       string // pre-rendered (letters or text); empty = hide
	Explanation  string
	// Score 每题分值（蓝本固有；0 = 无分值 → 整卷均分兜底）
	Score int
}

// PaperQuestion is one placed question inside a section.
type PaperQuestion struct {
	Number int
	Row    QuestionRow
	Score  int
}

// PaperSection is one 大题 (a run of same-type questions).
type PaperSection struct {
	Index     int // 1-based, rendered as 一/二/三…
	Title     string
	ScoreSum  int
	Uniform   int // per-question score when uniform, else 0
	Questions []PaperQuestion
}

// Paper is a fully laid-out exam paper.
type Paper struct {
	Title          string
	Style          string
	TotalScore     int
	DurationMin    int
	IncludeAnswers bool
	GeneratedAt    time.Time
	Sections       []PaperSection
}

// canonical section order + display titles (exam conventions).
var sectionOrder = []struct {
	Type  string
	Title string
}{
	{"single_choice", "单项选择题"},
	{"multi_choice", "多项选择题"},
	{"short_answer", "简答题"},
	{"essay", "论述题"},
}

var typeTitles = map[string]string{
	"single_choice": "单项选择题",
	"multi_choice":  "多项选择题",
	"short_answer":  "简答题",
	"essay":         "论述题",
}

// chineseNumerals renders 1..20 as 一..二十 (section ordinals).
func chineseNumeral(n int) string {
	if n <= 0 || n > 20 {
		return fmt.Sprintf("%d", n)
	}
	digits := []string{"", "一", "二", "三", "四", "五", "六", "七", "八", "九"}
	switch {
	case n <= 10:
		if n == 10 {
			return "十"
		}
		return digits[n]
	case n == 20:
		return "二十"
	default:
		if n < 20 {
			return "十" + digits[n-10]
		}
		return fmt.Sprintf("%d", n)
	}
}

// styleDuration returns the default exam duration (minutes) per style.
func styleDuration(style string) int {
	switch style {
	case StyleGaokao:
		return 120
	case StyleKaoyan:
		return 180
	default:
		return 90
	}
}

// annotatedSumWithRows sums the explicit per-question scores present on rows.
func annotatedSumWithRows(rows []QuestionRow) int {
	sum := 0
	for _, q := range rows {
		if q.Score > 0 {
			sum += q.Score
		}
	}
	return sum
}

// BuildPaper groups questions into sections and distributes the total score
// (every question gets total/N points; the first total%N questions absorb the
// remainder). Layout fails only on empty input or an unsupported style.
func BuildPaper(title, style string, totalScore int, durationMin int, includeAnswers bool, questions []QuestionRow) (*Paper, error) {
	if !ValidStyle(style) {
		return nil, fmt.Errorf("不支持的卷面风格: %s", style)
	}
	if len(questions) == 0 {
		return nil, fmt.Errorf("题卷没有可排版的题目")
	}
	if totalScore <= 0 {
		totalScore = 100
	}
	style = NormalizeStyle(style)
	if durationMin <= 0 {
		durationMin = styleDuration(style)
	}

	// group by canonical type order, preserving input order within a type
	buckets := make(map[string][]QuestionRow)
	for _, q := range questions {
		t := q.QuestionType
		if t == "" {
			t = "short_answer"
		}
		buckets[t] = append(buckets[t], q)
	}

	n := len(questions)
	base := totalScore / n
	rem := totalScore % n
	// 每题分值：题目自带 score（蓝本固有）优先；无分值行走整卷均分。
	// 带分值行存在时，卷面总分 = 实际分配合计（缩抽题后 != 传入 totalScore）。
	annotated := 0
	for _, q := range questions {
		if q.Score > 0 {
			annotated++
		}
	}
	useAnnotated := annotated > 0
	restBase := 0
	restRem := 0
	if useAnnotated {
		rest := totalScore - annotatedSumWithRows(questions)
		if rest < 0 {
			rest = 0
		}
		restBase = rest / (n - annotated)
		restRem = rest % (n - annotated)
	}

	paper := &Paper{
		Title:          title,
		Style:          style,
		TotalScore:     totalScore,
		DurationMin:    durationMin,
		IncludeAnswers: includeAnswers,
		GeneratedAt:    time.Now().UTC(),
	}
	if paper.Title == "" {
		paper.Title = "练习试卷"
	}

	placed := 0
	for _, sec := range sectionOrder {
		rows := buckets[sec.Type]
		if len(rows) == 0 {
			continue
		}
		delete(buckets, sec.Type)
		ps := PaperSection{Index: len(paper.Sections) + 1, Title: sec.Title}
		for _, row := range rows {
			score := 0
			switch {
			case row.Score > 0: // 题目固有分值（蓝本卷）
				score = row.Score
			case useAnnotated: // 分值标注卷的无分值题目：分摊余量
				score = restBase
				if restRem > 0 {
					score++
					restRem--
				}
			default: // 整卷均分（历史口径）
				score = base
				if placed < rem { // first rem questions get +1
					score++
				}
			}
			ps.ScoreSum += score
			ps.Questions = append(ps.Questions, PaperQuestion{Number: placed + 1, Row: row, Score: score})
			placed++
		}
		// uniform per-question display when every score matches
		ps.Uniform = ps.Questions[0].Score
		for _, q := range ps.Questions {
			if q.Score != ps.Uniform {
				ps.Uniform = 0
				break
			}
		}
		paper.Sections = append(paper.Sections, ps)
	}
	// unknown question types fall into a trailing 综合题 section
	for t, rows := range buckets {
		if len(rows) == 0 {
			continue
		}
		ps := PaperSection{Index: len(paper.Sections) + 1, Title: typeTitles[t]}
		if ps.Title == "" {
			ps.Title = "综合题"
		}

		for _, row := range rows {
			score := 0
			switch {
			case row.Score > 0:
				score = row.Score
			case useAnnotated:
				score = restBase
				if restRem > 0 {
					score++
					restRem--
				}
			default:
				score = base
				if placed < rem {
					score++
				}
			}
			ps.ScoreSum += score
			ps.Questions = append(ps.Questions, PaperQuestion{Number: placed + 1, Row: row, Score: score})
			placed++
		}
		ps.Uniform = ps.Questions[0].Score
		for _, q := range ps.Questions {
			if q.Score != ps.Uniform {
				ps.Uniform = 0
				break
			}
		}
		paper.Sections = append(paper.Sections, ps)
	}
	// 卷面总分 = 实际分配合计（分值标注卷缩抽题后与传入 totalScore 可能不同）
	sum := 0
	for _, ps := range paper.Sections {
		sum += ps.ScoreSum
	}
	paper.TotalScore = sum
	return paper, nil
}

// SectionHeader renders the 大题 header line (exam convention):
// 一、单项选择题（本题共 5 小题，每小题 4 分，共 20 分）
func (s *PaperSection) Header() string {
	var b strings.Builder
	b.WriteString(chineseNumeral(s.Index) + "、" + s.Title)
	if len(s.Questions) > 0 {
		fmt.Fprintf(&b, "（本题共 %d 小题，", len(s.Questions))
		if s.Uniform > 0 {
			fmt.Fprintf(&b, "每小题 %d 分，", s.Uniform)
		}
		fmt.Fprintf(&b, "共 %d 分）", s.ScoreSum)
	}
	return b.String()
}

// SectionTitleOnly is the short heading used on the answer pages.
func (s *PaperSection) TitleOnly() string {
	return chineseNumeral(s.Index) + "、" + s.Title
}
