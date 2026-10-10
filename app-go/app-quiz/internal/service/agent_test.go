package service

import (
	"encoding/json"
	"testing"
)

func TestValidateQuestions(t *testing.T) {
	if err := validateQuestions([]AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err != nil {
		t.Fatalf("valid question rejected: %v", err)
	}
	correctAnswerOnly := AgentQuestion{Question: "q", CorrectAnswer: json.RawMessage(`["a","b"]`), Explanation: "e"}
	if err := validateQuestions([]AgentQuestion{correctAnswerOnly}); err != nil {
		t.Fatalf("correct_answer-only question rejected: %v", err)
	}

	invalid := []AgentQuestion{
		{Question: "", Answer: "a", Explanation: "e"},
		{Question: "q", Answer: "", Explanation: "e"},
		{Question: "q", Answer: "a", Explanation: ""},
	}
	for i, q := range invalid {
		if err := validateQuestions([]AgentQuestion{q}); err == nil {
			t.Errorf("case %d: expected a validation error", i)
		}
	}
}

func TestToRepoQuestionsKeepsRichFields(t *testing.T) {
	out := toRepoQuestions([]AgentQuestion{{
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
	s := &Store{}
	if _, err := s.CreateAgentQuizSet(nil, 0, "t", []AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err == nil {
		t.Error("uid=0 should be rejected")
	}
	if _, err := s.CreateAgentQuizSet(nil, 1, "", []AgentQuestion{{Question: "q", Answer: "a", Explanation: "e"}}); err == nil {
		t.Error("empty title should be rejected")
	}
	if _, err := s.CreateQuizSet(nil, 1, QuizSetDraft{Title: "  "}); err == nil {
		t.Error("empty draft title should be rejected")
	}
	if _, err := s.FailQuizSet(nil, 1, "", "boom"); err == nil {
		t.Error("empty quiz_uuid should be rejected")
	}
}
