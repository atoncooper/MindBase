// Paper export — renders an owned quiz set as an exam-style docx paper.
// Storage reads stay on the repo layer; layout lives in internal/exampaper.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"app-quiz/internal/exampaper"
	"app-quiz/internal/repo"
)

// PaperOptions selects the export variant.
type PaperOptions struct {
	Style          string // exampaper style: standard / gaokao / kaoyan
	IncludeAnswers bool   // 参考答案与解析页（读取 full questions）
}

// BuildPaper loads the owned quiz (with answers when requested) and renders a
// printable exam paper. Expected failures come back as *APIError.
func (s *Store) BuildPaper(ctx context.Context, uid int64, quizUUID string, opts PaperOptions) ([]byte, string, error) {
	qs, err := repo.GetOwnedQuizSet(s.DB, quizUUID, uid)
	if err != nil {
		return nil, "", err
	}
	if qs == nil || deref(qs.Status) == "deleting" {
		return nil, "", apiErr(404, "题目集不存在")
	}
	if deref(qs.Status) == "generating" {
		return nil, "", apiErr(409, "题目正在生成中，稍后再导出")
	}

	var questions []repo.QuestionDoc
	if opts.IncludeAnswers {
		questions = repo.GetQuestionsFull(ctx, s.Mongo, quizUUID)
	} else {
		questions = repo.GetQuestions(ctx, s.Mongo, quizUUID)
	}
	if len(questions) == 0 {
		return nil, "", apiErr(410, "题目数据已丢失，请重新生成")
	}

	rows := make([]exampaper.QuestionRow, 0, len(questions))
	for _, q := range questions {
		row := exampaper.QuestionRow{
			QuestionUUID: docString(q["question_uuid"]),
			QuestionType: docString(q["question_type"]),
			QuestionText: docString(q["question_text"]),
			Options:      docStringList(q["options"]),
		}
		if opts.IncludeAnswers {
			row.Answer = docAnswer(q["correct_answer"])
			row.Explanation = docString(q["explanation"])
		}
		rows = append(rows, row)
	}

	paper, err := exampaper.BuildPaper(qs.Title, opts.Style, derefInt(qs.TotalScore), 0, opts.IncludeAnswers, rows)
	if err != nil {
		return nil, "", apiErr(400, err.Error())
	}
	data, err := paper.Docx()
	if err != nil {
		return nil, "", apiErr(500, "试卷生成失败，请稍后重试")
	}
	return data, qs.Title, nil
}

// docString reads a Mongo question field as a string (nil-safe).
func docString(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

// docStringList normalises the options field: native BSON arrays, or the
// JSON-string-encoded shape the frontend also tolerates.
func docStringList(v interface{}) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case []interface{}:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			} else {
				out = append(out, docString(item))
			}
		}
		return out
	case string:
		trimmed := strings.TrimSpace(t)
		if strings.HasPrefix(trimmed, "[") {
			var arr []interface{}
			if err := json.Unmarshal([]byte(trimmed), &arr); err == nil {
				return docStringList(arr)
			}
		}
		return []string{t}
	default:
		return []string{docString(v)}
	}
}

// docAnswer renders the correct answer for the answer pages (letters joined,
// lists joined with 、; scalars pass through).
func docAnswer(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []interface{}:
		parts := make([]string, 0, len(t))
		for _, item := range t {
			parts = append(parts, docAnswer(item))
		}
		return strings.Join(parts, "、")
	default:
		return docString(v)
	}
}
