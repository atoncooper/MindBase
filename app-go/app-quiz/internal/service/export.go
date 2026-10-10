// Quiz training-data export — port of app/services/quiz_export.py
// (JSONL / CSV / SFT). Rows are streamed one by one, exactly like the
// Python StreamingResponse generator.
package service

import (
	"encoding/json"
	"strconv"
	"strings"

	"app-quiz/internal/repo"

	"gorm.io/gorm"
)

// marshalNoHTMLEscape marshals without HTML escaping, matching Python's
// json.dumps(ensure_ascii=False) output for the shared-quiz cache payload.
func marshalNoHTMLEscape(v interface{}) ([]byte, error) {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// json.Encoder appends a newline; strip it for cache payloads.
	return []byte(strings.TrimSuffix(sb.String(), "\n")), nil
}

// ExportRecord is one exportable answer record in the Python service's shape.
type ExportRecord map[string]interface{}

// ExportFormat validates and normalises the requested export format.
func ExportFormat(format string) (string, bool) {
	switch format {
	case "", "jsonl":
		return "jsonl", true
	case "csv", "sft":
		return format, true
	}
	return "", false
}

// ExportSubmissions streams the user's answer records through write for the
// requested format. The folderIDs filter (nil = all) is applied in-process,
// mirroring the Python service.
func (s *Store) ExportSubmissions(db *gorm.DB, uid int64, folderIDs []int, format string, write func([]byte) error) error {
	rows, err := repo.ListExportRecords(db, uid)
	if err != nil {
		return err
	}
	switch format {
	case "csv":
		return s.exportCSV(rows, folderIDs, write)
	case "sft":
		return s.exportSFT(rows, folderIDs, write)
	default:
		return s.exportJSONL(rows, folderIDs, write)
	}
}

// iterRecords yields filtered, normalised records (parity with
// QuizDataExportService._iter_records).
func (s *Store) iterRecords(rows []repo.ExportRow, folderIDs []int, fn func(ExportRecord) error) error {
	for _, r := range rows {
		if len(folderIDs) > 0 && !folderIDsIntersect(r.FolderIDs, folderIDs) {
			continue
		}
		var userAnswer interface{}
		if len(r.UserAnswer) > 0 && string(r.UserAnswer) != "null" {
			userAnswer = parseJSONField(r.UserAnswer)
		} else {
			userAnswer = r.UserAnswerText
		}
		correctAnswer := parseJSONField(r.CorrectAnswerSnapshot)

		var options interface{}
		if len(r.Options) > 0 {
			options = parseJSONField(r.Options)
		}

		var contextSegment interface{}
		if r.SourceSegment != nil {
			seg := *r.SourceSegment
			if len(seg) > 500 {
				seg = seg[:500]
			}
			contextSegment = seg
		}

		rec := ExportRecord{
			"question":        r.QuestionText,
			"type":            r.QuestionType,
			"difficulty":      r.Difficulty,
			"options":         options,
			"correct_answer":  correctAnswer,
			"user_answer":     userAnswer,
			"is_correct":      r.IsCorrect != nil && *r.IsCorrect,
			"explanation":     r.Explanation,
			"context":         contextSegment,
			"bvid":            r.Bvid,
			"folder_id":       string(r.FolderIDs),
			"quiz_uuid":       r.QuizUUID,
			"submission_uuid": r.SubmissionUUID,
			"timestamp":       pyISO(r.SubmittedAt),
		}
		if err := fn(rec); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) exportJSONL(rows []repo.ExportRow, folderIDs []int, write func([]byte) error) error {
	return s.iterRecords(rows, folderIDs, func(rec ExportRecord) error {
		b, err := marshalNoHTMLEscape(rec)
		if err != nil {
			return err
		}
		return write(append(b, '\n'))
	})
}

var csvFieldnames = []string{
	"question", "type", "difficulty", "correct_answer", "user_answer",
	"is_correct", "explanation", "context", "bvid",
	"quiz_uuid", "submission_uuid", "timestamp",
}

func (s *Store) exportCSV(rows []repo.ExportRow, folderIDs []int, write func([]byte) error) error {
	var buf strings.Builder
	writeCSVRow(&buf, csvFieldnames)
	if err := write([]byte(buf.String())); err != nil {
		return err
	}
	return s.iterRecords(rows, folderIDs, func(rec ExportRecord) error {
		var line strings.Builder
		values := make([]string, 0, len(csvFieldnames))
		for _, name := range csvFieldnames {
			v := rec[name]
			if name == "correct_answer" || name == "user_answer" {
				v = joinList(v)
			}
			values = append(values, csvString(v))
		}
		writeCSVRow(&line, values)
		return write([]byte(line.String()))
	})
}

func (s *Store) exportSFT(rows []repo.ExportRow, folderIDs []int, write func([]byte) error) error {
	return s.iterRecords(rows, folderIDs, func(rec ExportRecord) error {
		qtype, _ := rec["type"].(string)
		userContent, _ := rec["question"].(string)
		if qtype == "single_choice" || qtype == "multi_choice" {
			var lines []string
			if opts, ok := rec["options"].([]interface{}); ok {
				for _, o := range opts {
					lines = append(lines, csvString(o))
				}
			}
			if len(lines) > 0 {
				userContent = userContent + "\n" + strings.Join(lines, "\n")
			}
		}
		answer := sftString(rec["correct_answer"])
		sft := map[string]interface{}{
			"messages": []map[string]string{
				{"role": "user", "content": userContent},
				{"role": "assistant", "content": answer},
			},
			"metadata": map[string]interface{}{
				"type":       rec["type"],
				"difficulty": rec["difficulty"],
				"bvid":       rec["bvid"],
			},
		}
		b, err := marshalNoHTMLEscape(sft)
		if err != nil {
			return err
		}
		return write(append(b, '\n'))
	})
}

// folderIDsIntersect parses the raw quiz_sets.folder_ids JSON (list of
// numbers) and reports whether any requested id is present.
func folderIDsIntersect(raw json.RawMessage, folderIDs []int) bool {
	var ids []interface{}
	if err := json.Unmarshal(raw, &ids); err != nil {
		return false
	}
	for _, v := range ids {
		n, ok := v.(float64)
		if !ok {
			continue
		}
		for _, fid := range folderIDs {
			if int(n) == fid {
				return true
			}
		}
	}
	return false
}

// joinList renders list-valued answers the way the Python CSV export does
// (", ".join(str(x) for x in list)); non-lists pass through unchanged.
func joinList(v interface{}) interface{} {
	items, ok := v.([]interface{})
	if !ok {
		return v
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, csvString(item))
	}
	return strings.Join(parts, ", ")
}

// sftString renders the assistant content the way Python's str(answer) does
// for the common shapes (string passthrough, list join, scalars via JSON).
func sftString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []interface{}:
		parts := make([]string, 0, len(t))
		for _, item := range t {
			parts = append(parts, csvString(item))
		}
		return strings.Join(parts, ", ")
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		b, err := marshalNoHTMLEscape(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// csvString renders a scalar for CSV output (parity with Python str()).
func csvString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		b, err := marshalNoHTMLEscape(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// writeCSVRow appends one RFC4180 row (minimal quoting + CRLF terminator,
// matching Python's csv.writer default dialect).
func writeCSVRow(sb *strings.Builder, fields []string) {
	for i, f := range fields {
		if i > 0 {
			sb.WriteByte(',')
		}
		if strings.ContainsAny(f, ",\"\r\n") {
			sb.WriteByte('"')
			sb.WriteString(strings.ReplaceAll(f, "\"", "\"\""))
			sb.WriteByte('"')
		} else {
			sb.WriteString(f)
		}
	}
	sb.WriteString("\r\n")
}
