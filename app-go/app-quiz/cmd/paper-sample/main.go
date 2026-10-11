// paper-sample generates two sample exam papers (gaokao + kaoyan styles) into
// the OS temp dir — a manual debugging aid for the docx export face.
package main

import (
	"os"
	"path/filepath"

	"app-quiz/internal/exampaper"
)

func main() {
	rows := []exampaper.QuestionRow{
		{QuestionType: "single_choice", QuestionText: "已知函数 f(x)=x²+2x，则 f(x) 的最小值为（　　）", Options: []string{"A. -1", "B. 0", "C. 1", "D. 2"}, Answer: "A", Explanation: "配方法：f(x)=(x+1)²-1。"},
		{QuestionType: "multi_choice", QuestionText: "下列说法正确的有", Options: []string{"A. 甲", "B. 乙", "C. 丙", "D. 丁"}, Answer: "A、C", Explanation: "略"},
		{QuestionType: "short_answer", QuestionText: "简述导数的几何意义。", Answer: "切线斜率", Explanation: "略"},
		{QuestionType: "essay", QuestionText: "论述微积分基本定理的意义。", Answer: "略", Explanation: "按要点给分"},
	}
	out := os.TempDir()
	paper, err := exampaper.BuildPaper("高考模拟练习·数学（一）", exampaper.StyleGaokao, 100, 0, true, rows)
	if err != nil {
		panic(err)
	}
	data, err := paper.Docx()
	if err != nil {
		panic(err)
	}
	gaokao := filepath.Join(out, "sample_gaokao.docx")
	if err := os.WriteFile(gaokao, data, 0o644); err != nil {
		panic(err)
	}
	paper2, _ := exampaper.BuildPaper("2026 年全国硕士研究生招生考试模拟·计算机学科", exampaper.StyleKaoyan, 100, 0, false, rows)
	data2, _ := paper2.Docx()
	kaoyan := filepath.Join(out, "sample_kaoyan.docx")
	if err := os.WriteFile(kaoyan, data2, 0o644); err != nil {
		panic(err)
	}
	println("written: " + gaokao)
	println("written: " + kaoyan)
}
