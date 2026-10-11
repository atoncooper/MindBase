/**
 * Exam paper HTML builder — the single source for the 试卷 (exam paper) layout.
 * One renderer powers three outputs:
 *   1. in-app preview (iframe srcDoc)
 *   2. 打印 / 另存为 PDF (window.print on a popup document)
 *   3. .html download
 * The docx face is served by app-quiz (GET /quiz/${/paper).
 */
import type { QuizSetData, QuizQuestion } from "@/lib/api";

export type PaperStyle = "standard" | "gaokao" | "kaoyan";

export interface ExamPaperOptions {
    style: PaperStyle;
    includeAnswers: boolean;
    /** 建议考试用时（分钟）；空 = 按风格默认 */
    durationMinutes?: number | null;
}

interface PaperSection {
    index: number;
    title: string;
    scoreSum: number;
    uniform: number; // per-question score when uniform, else 0
    questions: Array<{ number: number; q: QuizQuestion; score: number }>;
}

const SECTION_ORDER: Array<{ type: string; title: string }> = [
    { type: "single_choice", title: "单项选择题" },
    { type: "multi_choice", title: "多项选择题" },
    { type: "short_answer", title: "简答题" },
    { type: "essay", title: "论述题" },
];

const TYPE_TITLES: Record<string, string> = {
    single_choice: "单项选择题",
    multi_choice: "多项选择题",
    short_answer: "简答题",
    essay: "论述题",
};

const CN_NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function chineseNumeral(n: number): string {
    if (n >= 1 && n <= 10) return CN_NUM[n];
    if (n > 10 && n < 20) return "十" + CN_NUM[n - 10];
    return String(n);
}

function styleDuration(style: PaperStyle): number {
    if (style === "gaokao") return 120;
    if (style === "kaoyan") return 180;
    return 90;
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Group questions into sections and distribute totalScore (total/N each, first total%N get +1). */
export function groupPaperSections(quiz: QuizSetData): PaperSection[] {
    const buckets = new Map<string, QuizQuestion[]>();
    for (const q of quiz.questions) {
        const t = q.question_type || "short_answer";
        if (!buckets.has(t)) buckets.set(t, []);
        (buckets.get(t) as QuizQuestion[]).push(q);
    }
    const total = quiz.total_score > 0 ? quiz.total_score : 100;
    const n = quiz.questions.length || 1;
    const base = Math.floor(total / n);
    let rem = total % n;
    const sections: PaperSection[] = [];
    const take = (type: string, title: string) => {
        const qs = buckets.get(type);
        if (!qs || qs.length === 0) return;
        buckets.delete(type);
        const sec: PaperSection = { index: sections.length + 1, title, scoreSum: 0, uniform: 0, questions: [] };
        let startNum = 0;
        qs.forEach((q) => {
            startNum += 1;
            let score = base;
            if (rem > 0) {
                score += 1;
                rem -= 1;
            }
            sec.scoreSum += score;
            sec.questions.push({ number: startNum, q, score });
        });
        sec.uniform = sec.questions[0].score;
        for (const item of sec.questions) {
            if (item.score !== sec.uniform) {
                sec.uniform = 0;
                break;
            }
        }
        sections.push(sec);
    };
    for (const s of SECTION_ORDER) take(s.type, s.title);
    // unknown types fall into a trailing 综合题 section
    for (const [type, qs] of buckets) {
        if (qs.length === 0) continue;
        take(type, TYPE_TITLES[type] ?? "综合题");
    }
    return sections;
}

/** Extract the option label (A/B/…) or synthesize one from the index. */
function optionLabel(opt: string, index: number): string {
    const m = /^\s*([A-Za-z])(?:[.．、\s]+|$)/.exec(opt);
    if (m) return m[1].toUpperCase();
    return String.fromCharCode("A".charCodeAt(0) + index);
}

function stripOptionLabel(opt: string): string {
    return opt.replace(/^\s*[A-Za-z](?:[.．、\s]+)/, "").trim() || opt;
}

function notices(style: PaperStyle): string[] {
    if (style === "gaokao") {
        return [
            "1. 答题前，考生务必将自己的姓名、准考证号填写在答题卡上。",
            "2. 回答选择题时，选出每小题答案后，用铅笔把答题卡上对应题目的答案标号涂黑。如需改动，用橡皮擦干净后再选涂其他答案标号。",
            "3. 回答非选择题时，将答案写在答题卡上。写在本试卷上无效。",
            "4. 考试结束后，将本试卷和答题卡一并交回。",
        ];
    }
    if (style === "kaoyan") {
        return [
            "1. 考生须严格遵守考场规则，考生在答题前，须将自己的姓名、考生编号填写在答题卡（纸）上。",
            "2. 答案须书写在答题卡（纸）的相应位置，书写在试题册上的答案无效。",
            "3. 选择题须用 2B 铅笔将答题卡上对应题目的答案标号按要求涂黑；非选择题须用黑色字迹签字笔作答。",
            "4. 考试结束后，将答题卡（纸）和试题册一并交回。",
        ];
    }
    return [
        "1. 请将姓名等信息填写在试卷指定位置，答案写在对应题目下方或答题纸。",
        "2. 选择题从选项中选出符合题意的答案；简答与论述题按要点作答。",
        "3. 考试结束后，将试卷一并交回。",
    ];
}

function answerText(a: unknown): string {
    if (a == null) return "";
    if (Array.isArray(a)) return a.map((x) => String(x)).join("、");
    return String(a);
}

/** Build the complete self-contained A4 print HTML for one quiz. */
export function buildExamPaperHtml(quiz: QuizSetData, opts: ExamPaperOptions): string {
    const style = opts.style;
    const duration = opts.durationMinutes && opts.durationMinutes > 0 ? opts.durationMinutes : styleDuration(style);
    const totalScore = quiz.total_score > 0 ? quiz.total_score : 100;
    const sections = groupPaperSections(quiz);
    const title = quiz.title || "练习试卷";

    const header =
        style === "kaoyan"
            ? [
                  '<p class="exam-banner">' + new Date().getFullYear() + " 年全国硕士研究生招生考试</p>",
                  '<h1 class="exam-title">' + esc(title) + "</h1>",
                  '<p class="exam-meta">（满分 ' + totalScore + " 分，考试时间 " + duration + " 分钟）</p>",
              ]
            : [
                  style === "gaokao" ? '<p class="exam-banner">绝密★启用前</p>' : "",
                  '<h1 class="exam-title">' + esc(title) + "</h1>",
                  '<p class="exam-meta">考试时间：' + duration + " 分钟　　满分：" + totalScore + " 分</p>",
              ].filter(Boolean);

    const identity =
        style !== "standard"
            ? '<p class="exam-identity">姓名：____________　准考证号：____________　考场：________　座位号：________</p>'
            : "";

    const bodySections = sections
        .map((sec) => {
            const head =
                chineseNumeral(sec.index) + "、" + sec.title + "（本题共 " + sec.questions.length + " 小题，" +
                (sec.uniform > 0 ? "每小题 " + sec.uniform + " 分，" : "") + "共 " + sec.scoreSum + " 分）";
            const blocks = sec.questions
                .map(({ number, q, score }) => {
                    const multiMark = q.question_type === "multi_choice" && !/多选/.test(q.question_text) ? "（多选）" : "";
                    let h = '<div class="question">';
                    h += '<p class="stem"><b>' + number + ".</b>（" + score + " 分" + multiMark + "）" + esc(q.question_text) + "</p>";
                    if (q.options && q.options.length > 0) {
                        h += '<div class="options">';
                        q.options.forEach((opt, i) => {
                            h +=
                                '<p class="option"><span class="opt-label">' +
                                esc(optionLabel(opt, i)) +
                                "．</span>" +
                                esc(stripOptionLabel(opt)) +
                                "</p>";
                        });
                        h += "</div>";
                    }
                    if (q.question_type === "short_answer") {
                        h += '<div class="blank"></div>'.repeat(3);
                    } else if (q.question_type === "essay") {
                        h += '<div class="blank"></div>'.repeat(8);
                    }
                    h += "</div>";
                    return h;
                })
                .join("");
            return '<div class="section"><p class="section-head">' + esc(head) + "</p>" + blocks + "</div>";
        })
        .join("");

    const answerPage = !opts.includeAnswers
        ? ""
        : '<div class="answers-page"><h2 class="answers-title">参考答案与解析</h2>' +
          sections
              .map((sec) => {
                  const rows = sec.questions
                      .filter(({ q }) => answerText(q.correct_answer) || q.explanation)
                      .map(({ number, q }) => {
                          let row = '<p class="answer-row"><b>' + number + ".</b> ";
                          const a = answerText(q.correct_answer);
                          if (a) row += "【答案】" + esc(a) + "　";
                          if (q.explanation) row += "【解析】" + esc(q.explanation);
                          row += "</p>";
                          return row;
                      })
                      .join("");
                  if (!rows) return "";
                  return (
                      '<div class="answers-section"><p class="section-head">' +
                      esc(chineseNumeral(sec.index) + "、" + sec.title) +
                      "</p>" +
                      rows +
                      "</div>"
                  );
              })
              .join("") +
          "</div>";

    const noticeHtml = ["注意事项：", ...notices(style)]
        .map((n, i) => (i === 0 ? '<p class="notice-head">' + n + "</p>" : '<p class="notice-line">' + esc(n) + "</p>"))
        .join("");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Times New Roman", "SimSun", "宋体", serif;
    font-size: 10.5pt; line-height: 1.7; color: #000;
    background: #f0f0f0;
  }
  .paper {
    max-width: 210mm; margin: 0 auto; background: #fff;
    padding: 18mm 16mm; min-height: 297mm;
  }
  .exam-banner { text-align: center; font-family: "SimHei", "黑体", sans-serif; font-weight: 700; margin: 0 0 4px; }
  .exam-title { text-align: center; font-family: "SimHei", "黑体", sans-serif; font-size: 16pt; font-weight: 700; margin: 6px 0 4px; }
  .exam-meta { text-align: center; margin: 0 0 8px; }
  .exam-identity { text-align: center; margin: 8px 0 10px; }
  .notice-head { font-family: "SimHei", "黑体", sans-serif; font-weight: 700; margin: 10px 0 2px; }
  .notice-line { margin: 0 0 2px; font-size: 9.5pt; line-height: 1.6; }
  .section { margin-top: 14px; }
  .section-head { font-family: "SimHei", "黑体", sans-serif; font-weight: 700; font-size: 12pt; margin: 0 0 6px; }
  .question { break-inside: avoid; margin: 0 0 10px; }
  .stem { margin: 0 0 4px; }
  .options { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin: 2px 0 4px 2em; }
  .option { margin: 0; line-height: 1.6; }
  .opt-label { font-weight: 600; }
  .blank { height: 30px; border-bottom: 1px solid #000; margin: 0 0 12px; }
  .answers-page { break-before: page; }
  .answers-title { text-align: center; font-family: "SimHei", "黑体", sans-serif; font-size: 14pt; margin: 0 0 12px; }
  .answers-section { margin: 0 0 10px; }
  .answer-row { margin: 0 0 4px; }
  .print-bar {
    position: fixed; top: 12px; right: 14px; display: flex; gap: 8px;
    font-family: system-ui, sans-serif;
  }
  .print-bar button {
    border: 1px solid #333; background: #fff; color: #111; border-radius: 999px;
    padding: 6px 16px; font-size: 13px; cursor: pointer;
  }
  @media print {
    body { background: #fff; }
    .paper { padding: 0; max-width: none; }
    .print-bar { display: none; }
  }
</style>
</head>
<body>
<div class="print-bar">
  <button onclick="window.print()">打印 / 保存 PDF</button>
</div>
<div class="paper">
  ${header.join("\n  ")}
  ${identity}
  ${noticeHtml}
  ${bodySections}
  ${answerPage}
</div>
<script>
  // 弹出打印对话框（另存为 PDF）；弹窗被拦截时用户可点右上角按钮
  window.addEventListener("load", function () {
    setTimeout(function () { try { window.print(); } catch (e) {} }, 350);
  });
</script>
</body>
</html>`;
}

/** Open the paper in a popup window and trigger print (另存为 PDF). */
export function printExamPaper(html: string): boolean {
    const win = window.open("", "_blank");
    if (!win) return false;
    win.document.open();
    win.document.write(html);
    win.document.close();
    return true;
}

/** Download the paper HTML as a file. */
export function downloadExamPaperHtml(quiz: QuizSetData, opts: ExamPaperOptions): void {
    const html = buildExamPaperHtml(quiz, opts);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (quiz.title || "试卷") + ".html";
    a.click();
    URL.revokeObjectURL(url);
}
