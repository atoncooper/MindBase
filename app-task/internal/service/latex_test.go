package service

import "testing"

func TestLatexToText(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"empty", "", ""},
		{"plain text", "不存在", "不存在"},
		{"number", "0", "0"},
		{"frac simple", `\frac{1}{6}`, "1/6"},
		{"frac with sign", `-\frac{1}{6}`, "-1/6"},
		{"frac complex", `\frac{\sin x - x}{x^3}`, "(sin x - x)/(x^3)"},
		{"question", `设函数 $ f(x) = \frac{\sin x - x}{x^3} $，则极限 $ \lim_{x \to 0} f(x) $ 的值为（ ）。`,
			"设函数 f(x) = (sin x - x)/(x^3)，则极限 lim(x -> 0) f(x) 的值为（）。"},
		{"sqrt", `\sqrt{x}`, "√(x)"},
		{"symbols", `\pi \leq \infty \times \int`, "π ≤ ∞ × ∫"},
		{"sup sub", `x^2 + y_{n}`, "x^2 + y_n"},
		{"text cmd", `\text{abc}`, "abc"},
		{"left right", `\left( a + b \right)`, "(a + b)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := latexToText(tt.in)
			if got != tt.want {
				t.Errorf("latexToText(%q)\n got = %q\nwant = %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestLatexToTextSlice(t *testing.T) {
	in := []string{`-\frac{1}{6}`, "0", `\frac{1}{6}`, "不存在"}
	want := []string{"-1/6", "0", "1/6", "不存在"}
	got := latexToTextSlice(in)
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("slice[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
