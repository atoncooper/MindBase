package service

import "testing"

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
		if got := stripOptionLabel(in); got != want {
			t.Errorf("stripOptionLabel(%q) = %q, want %q", in, got, want)
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
		if got := choiceLetter(options, tc.answer); got != tc.want {
			t.Errorf("choiceLetter(%q) = %q, want %q", tc.answer, got, tc.want)
		}
	}
}

func TestJudgeTaskQuizAnswer(t *testing.T) {
	choice := map[string]interface{}{
		"question_type": "choice",
		"options":       []interface{}{"A. 收敛", "B. 发散"},
		"answer":        "B. 发散",
	}
	if !judgeTaskQuizAnswer(choice, "发散") {
		t.Error("choice: label-less answer should match the stored option text")
	}
	if !judgeTaskQuizAnswer(choice, "B") {
		t.Error("choice: bare letter should match")
	}
	if judgeTaskQuizAnswer(choice, "A. 收敛") {
		t.Error("choice: wrong option must not match")
	}

	short := map[string]interface{}{"question_type": "short_answer", "answer": "闭包"}
	if !judgeTaskQuizAnswer(short, "什么是闭包呢？") {
		t.Error("short_answer: containment (case-insensitive) expected")
	}
	if judgeTaskQuizAnswer(short, "函数") {
		t.Error("short_answer: unrelated answer must not match")
	}

	fill := map[string]interface{}{"question_type": "fill_blank", "answer": "42"}
	if !judgeTaskQuizAnswer(fill, " 42 ") {
		t.Error("fill_blank: trimmed exact compare expected")
	}
	if judgeTaskQuizAnswer(fill, "43") {
		t.Error("fill_blank: different value must not match")
	}

	if judgeTaskQuizAnswer(nil, "x") {
		t.Error("nil question must judge false")
	}
	if judgeTaskQuizAnswer(map[string]interface{}{"answer": ""}, "x") {
		t.Error("empty correct answer must judge false")
	}
}

func TestParseCCEmails(t *testing.T) {
	empty := ""
	if got := parseCCEmails(nil); len(got) != 0 {
		t.Errorf("nil → %v", got)
	}
	if got := parseCCEmails(&empty); len(got) != 0 {
		t.Errorf("empty string → %v", got)
	}
	list := `["a@b.c","d@e.f"]`
	got := parseCCEmails(&list)
	if len(got) != 2 || got[0] != "a@b.c" {
		t.Errorf("list → %v", got)
	}
	bad := "{not json"
	if got := parseCCEmails(&bad); len(got) != 0 {
		t.Errorf("invalid json → %v", got)
	}
}
