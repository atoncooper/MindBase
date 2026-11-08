package tests

import (
	"encoding/json"
	"testing"

	quizsvc "app-content/internal/service/quiz"
)

func TestValidateQuestions(t *testing.T) {
	if err := quizsvc.ValidateQuestions([]quizsvc.AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err != nil {
		t.Fatalf("valid question rejected: %v", err)
	}
	correctAnswerOnly := quizsvc.AgentQuestion{Question: "q", CorrectAnswer: json.RawMessage(`["a","b"]`), Explanation: "e"}
	if err := quizsvc.ValidateQuestions([]quizsvc.AgentQuestion{correctAnswerOnly}); err != nil {
		t.Fatalf("correct_answer-only question rejected: %v", err)
	}

	invalid := []quizsvc.AgentQuestion{
		{Question: "", Answer: "a", Explanation: "e"},
		{Question: "q", Answer: "", Explanation: "e"},
		{Question: "q", Answer: "a", Explanation: ""},
	}
	for i, q := range invalid {
		if err := quizsvc.ValidateQuestions([]quizsvc.AgentQuestion{q}); err == nil {
			t.Errorf("case %d: expected a validation error", i)
		}
	}
}

func TestToRepoQuestionsKeepsRichFields(t *testing.T) {
	out := quizsvc.ToRepoQuestions([]quizsvc.AgentQuestion{{
		Question:     "q",
		QuestionType: "multi_choice",
		Difficulty:   "hard",
		Options:      []string{"A", "B"},
		Answer:       "A",
		Explanation:  "e",
		Keywords:     []string{"k1", "k2"},
	}})
	if len(out) != 1 {
		t.Fatalf("len=%d", len(out))
	}
	got := out[0]
	if got.QuestionType != "multi_choice" || got.Difficulty != "hard" {
		t.Errorf("type/difficulty lost: %+v", got)
	}
	if len(got.Keywords) != 2 || len(got.Options) != 2 {
		t.Errorf("list fields lost: %+v", got)
	}
}

// CreateQuizSet/CreateAgentQuizSet validate before touching the DB, so the
// failure paths are testable with a bare Store.
func TestCreateQuizSetValidationDoesNotTouchDB(t *testing.T) {
	s := &quizsvc.Store{}
	if _, err := s.CreateAgentQuizSet(nil, 0, "t", []quizsvc.AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err == nil {
		t.Error("uid=0 should be rejected")
	}
	if _, err := s.CreateAgentQuizSet(nil, 1, "", []quizsvc.AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err == nil {
		t.Error("empty title should be rejected")
	}
	if _, err := s.CreateQuizSet(nil, 1, quizsvc.QuizSetDraft{Title: "  "}); err == nil {
		t.Error("empty draft title should be rejected")
	}
	if _, err := s.FailQuizSet(nil, 1, "", "boom"); err == nil {
		t.Error("empty quiz_uuid should be rejected")
	}
}

// 超时清扫的终态决策：checkpoint 有题 → partial（可练），无题/未知 → failed。
func TestStatusForTimedGeneration(t *testing.T) {
	if status, msg := quizsvc.StatusForTimedGeneration(7); status != "partial" || msg == "" {
		t.Fatalf("count>0 should be partial, got %s / %s", status, msg)
	}
	if status, _ := quizsvc.StatusForTimedGeneration(0); status != "failed" {
		t.Fatalf("count=0 should be failed, got %s", status)
	}
	if status, _ := quizsvc.StatusForTimedGeneration(-1); status != "failed" {
		t.Fatalf("mongo unavailable (-1) should fail safe, got %s", status)
	}
}

func TestStripOptionLabel(t *testing.T) {
	cases := map[string]string{
		"A. 收敛": "收敛",
		"B、发散":  "发散",
		"C) 极限": "极限",
		"D 单调":  "单调",
		"收敛":    "收敛",
		"Apple": "Apple",
		"：x":    "：x",
		"":      "",
	}
	for in, want := range cases {
		if got := quizsvc.StripOptionLabel(in); got != want {
			t.Errorf("quizsvc.StripOptionLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestChoiceLetter(t *testing.T) {
	options := []string{"A. 收敛", "B. 发散", "C. 极限"}
	cases := []struct {
		answer string
		want   string
	}{
		{"B", "B"},
		{"b", ""},      // bare letter compare is case-sensitive (Python parity)
		{"B. 发散", "B"}, // full option text
		{"发散", "B"},    // label-less text
		{"A. 收敛", "A"},
		{"不存在", ""},
	}
	for _, tc := range cases {
		if got := quizsvc.ChoiceLetter(options, tc.answer); got != tc.want {
			t.Errorf("quizsvc.ChoiceLetter(%q) = %q, want %q", tc.answer, got, tc.want)
		}
	}
}

func TestJudgeTaskQuizAnswer(t *testing.T) {
	choice := map[string]interface{}{
		"question_type": "choice",
		"options":       []interface{}{"A. 收敛", "B. 发散"},
		"answer":        "B. 发散",
	}
	if !quizsvc.JudgeTaskQuizAnswer(choice, "发散") {
		t.Error("choice: label-less answer should match the stored option text")
	}
	if !quizsvc.JudgeTaskQuizAnswer(choice, "B") {
		t.Error("choice: bare letter should match")
	}
	if quizsvc.JudgeTaskQuizAnswer(choice, "A. 收敛") {
		t.Error("choice: wrong option must not match")
	}

	short := map[string]interface{}{"question_type": "short_answer", "answer": "闭包"}
	if !quizsvc.JudgeTaskQuizAnswer(short, "什么是闭包呢？") {
		t.Error("short_answer: containment (case-insensitive) expected")
	}
	if quizsvc.JudgeTaskQuizAnswer(short, "函数") {
		t.Error("short_answer: unrelated answer must not match")
	}

	fill := map[string]interface{}{"question_type": "fill_blank", "answer": "42"}
	if !quizsvc.JudgeTaskQuizAnswer(fill, " 42 ") {
		t.Error("fill_blank: trimmed exact compare expected")
	}
	if quizsvc.JudgeTaskQuizAnswer(fill, "43") {
		t.Error("fill_blank: different value must not match")
	}

	if quizsvc.JudgeTaskQuizAnswer(nil, "x") {
		t.Error("nil question must judge false")
	}
	if quizsvc.JudgeTaskQuizAnswer(map[string]interface{}{"answer": ""}, "x") {
		t.Error("empty correct answer must judge false")
	}
}

func TestParseCCEmails(t *testing.T) {
	empty := ""
	if got := quizsvc.ParseCCEmails(nil); len(got) != 0 {
		t.Errorf("nil → %v", got)
	}
	if got := quizsvc.ParseCCEmails(&empty); len(got) != 0 {
		t.Errorf("empty string → %v", got)
	}
	list := `["a@b.c","d@e.f"]`
	got := quizsvc.ParseCCEmails(&list)
	if len(got) != 2 || got[0] != "a@b.c" {
		t.Errorf("list → %v", got)
	}
	bad := "{not json"
	if got := quizsvc.ParseCCEmails(&bad); len(got) != 0 {
		t.Errorf("invalid json → %v", got)
	}
}
