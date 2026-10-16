/**
 * Exam paper HTML builder — the single source for the 试卷 (exam paper) layout.
 * One renderer powers three outputs:
 *   1. in-app preview (iframe srcDoc)
 *   2. 打印 / 另存为 PDF (window.print on a popup document)
 *   3. .html download
 * The docx face is served by app-quiz (GET /quiz/${/paper).
 */
import katex from "katex";
import { KATEX_INLINE_CSS } from "./katex-inline";
import type { QuizSetData, QuizQuestion } from "@/lib/api";

export type PaperStyle =
    | "standard"
    | "gaokao"
    | "kaoyan"
    | "kaoyan-math"
    | "kaoyan-408"
    | "kaoyan-engineering";

export interface ExamPaperOptions {
    style: PaperStyle;
    includeAnswers: boolean;
    /** 建议考试用时（分钟）；空 = 按风格默认 */
    durationMinutes?: number | null;
    /** 题型 → 每题分值（存量老卷：由 type_distribution 匹配蓝本推断，调用方计算） */
    typeScores?: Record<string, number> | null;
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
    if (style === "kaoyan" || style === "kaoyan-math" || style === "kaoyan-408" || style === "kaoyan-engineering") return 180;
    return 90;
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ── LaTeX 公式渲染（打印/PDF/预览同一份 HTML）─────────────────────────
// KaTeX output:"mathml" 产出纯 MathML 语义标记：无 CSS/字体文件依赖，
// Chromium/Edge 原生渲染并随打印输出，Word 打开 .html 亦可用。渲染失败时
// 保留原文（$...$），不让一道坏公式毁掉整卷。

function renderTex(tex: string, displayMode: boolean): string {
    const cleaned = tex.trim();
    if (!cleaned) return "";
    let html: string;
    try {
        // output:"html" = KaTeX 自排版像素级输出（配合内联字体 CSS），不依赖
        // MathML 支持——WPS/Word 打开 HTML、旧内核打印环境同样渲染一致。
        html = katex.renderToString(cleaned, { output: "html", throwOnError: false, displayMode });
    } catch {
        return esc((displayMode ? "$$" : "$") + cleaned + (displayMode ? "$$" : "$"));
    }
    return '<span class="' + (displayMode ? "math-display" : "math-inline") + '">' + html + "</span>";
}

/**
 * 剥离模型写在题干里的「本题满分 N 分」类注记——卷面按每题分值体系自己
 * 印分值，避免模型自注分数与卷面分配不一致的自相矛盾。
 */
export function stripScoreNote(s: string): string {
    return s
        .replace(/[（(]\s*(?:本\s*题\s*满\s*分|满\s*分)\s*[0-9０-９]+(?:\.[0-9０-９]+)?\s*分\s*[）)]/g, "")
        .replace(/[（(]\s*共\s*[0-9０-９]+\s*分\s*[）)]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/**
 * 文本 → HTML：扫描 $$…$$ / \[…\]（展示公式）、\(…\)、\$…\$（行内公式）
 * 段交给 KaTeX，其余文本 esc() 转义。
 */
export function renderMathText(s: string): string {
    if (!s) return "";
    let out = "";
    let plain = "";
    const flush = () => {
        if (plain) {
            out += esc(plain);
            plain = "";
        }
    };
    let i = 0;
    const n = s.length;
    while (i < n) {
        const rest = s.slice(i);
        if (rest.startsWith("$$")) {
            const end = s.indexOf("$$", i + 2);
            if (end !== -1) {
                flush();
                out += renderTex(s.slice(i + 2, end), true);
                i = end + 2;
                continue;
            }
        }
        if (rest.startsWith("\\[")) {
            const end = s.indexOf("\\]", i + 2);
            if (end !== -1) {
                flush();
                out += renderTex(s.slice(i + 2, end), true);
                i = end + 2;
                continue;
            }
        }
        if (rest.startsWith("\\(")) {
            const end = s.indexOf("\\)", i + 2);
            if (end !== -1) {
                flush();
                out += renderTex(s.slice(i + 2, end), false);
                i = end + 2;
                continue;
            }
        }
        if (s[i] === "$") {
            const end = s.indexOf("$", i + 1);
            if (end > i + 1) {
                flush();
                out += renderTex(s.slice(i + 1, end), false);
                i = end + 1;
                continue;
            }
        }
        plain += s[i];
        i += 1;
    }
    flush();
    return out;
}

/**
 * 从题干文本解析模型自注的分值（「（本题满分 12 分）」「（满分 10 分）」）。
 * 仅用于存量老卷（无 score 字段）的分值兜底；新卷生成已禁止题干带分值。
 */
export function scoreFromText(text: string): number {
    const m = /[（(]\s*(?:本题\s*满\s*分|满\s*分)\s*([0-9]+(?:\.[0-9]+)?)\s*分\s*[）)]/.exec(text ?? "");
    if (!m) return 0;
    const v = Number(m[1]);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 题目分值：显式 score（新卷）→ 题干自注分值（存量卷）→ typeScores（蓝本推断）→ 0。 */
function questionAnnotatedScore(q: QuizQuestion, typeScores?: Record<string, number> | null): number {
    if (typeof q.score === "number" && q.score > 0) return q.score;
    const fromStem = scoreFromText(q.question_text ?? "");
    if (fromStem > 0) return fromStem;
    const byType = typeScores?.[q.question_type ?? ""];
    if (typeof byType === "number" && byType > 0) return byType;
    return 0;
}

/**
 * Group questions into sections and assign per-question scores:
 *  - 题目自带 score（蓝本固有分值）→ 直接采用；
 *  - 无分值题目按「卷面总分 − 已标注合计」均摊（余数给前几题）；
 *  - 整卷无标注 → 维持旧的整卷均分（total/N，首 total%N 题各 +1）。
 */
export function groupPaperSections(quiz: QuizSetData, typeScores?: Record<string, number> | null): PaperSection[] {
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
    // 标注分值优先：显式 score 或题干自注分值（存量老卷）都算「已标注」，
    // 未标注题目分摊余量；整卷无任何标注 → 维持整卷均分。

    const annotated = quiz.questions.filter((q) => questionAnnotatedScore(q, typeScores) > 0);
    const annotatedSum = annotated.reduce((a, q) => a + questionAnnotatedScore(q, typeScores), 0);
    const useAnnotated = annotated.length > 0;
    const unscoredCount = quiz.questions.length - annotated.length;
    const restBudget = useAnnotated && unscoredCount > 0 ? Math.max(0, total - annotatedSum) : 0;
    const restShare = unscoredCount > 0 ? Math.max(1, Math.floor(restBudget / unscoredCount)) : 0;
    let restExtra = unscoredCount > 0 ? restBudget - restShare * unscoredCount : 0;
    const sections: PaperSection[] = [];
    const take = (type: string, title: string) => {
        const qs = buckets.get(type);
        if (!qs || qs.length === 0) return;
        buckets.delete(type);
        const sec: PaperSection = { index: sections.length + 1, title, scoreSum: 0, uniform: 0, questions: [] };
        qs.forEach((q) => {
            qNumber += 1; // 全卷连续题号：每题自增，跨大题不重置（对齐 docx 侧 placed+1）
            let score: number;
            const own = questionAnnotatedScore(q, typeScores);
            if (useAnnotated) {
                if (own > 0) {
                    score = own;
                } else {
                    score = restShare;
                    if (restExtra > 0) {
                        score += 1;
                        restExtra -= 1;
                    }
                }
            } else {
                score = base;
                if (rem > 0) {
                    score += 1;
                    rem -= 1;
                }
            }
            sec.scoreSum += score;
            sec.questions.push({ number: qNumber, q, score });
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
    let qNumber = 0; // 全卷连续题号（跨大题递增，不重置）
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
    if (style === "kaoyan" || style === "kaoyan-math" || style === "kaoyan-408" || style === "kaoyan-engineering") {
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

/**
 * 存量老卷分值推断：quiz.type_distribution 与某蓝本分布精确匹配 →
 * 取该蓝本的题型均分表。无匹配返回 null（读取端走整卷均分兜底）。
 */
export function inferTypeScoresFromCatalog(
    catalog: Array<{ distribution?: Record<string, number>; type_scores?: Record<string, number> }>,
    dist: Record<string, number> | undefined | null,
): Record<string, number> | null {
    if (!dist || typeof dist !== "object") return null;
    const keys = Object.keys(dist).filter((k) => Number(dist[k]) > 0);
    if (keys.length === 0) return null;
    for (const bp of catalog) {
        const d = bp.distribution;
        if (!d) continue;
        const dk = Object.keys(d).filter((k) => Number(d[k]) > 0);
        if (dk.length !== keys.length) continue;
        if (!keys.every((k) => Math.abs(Number(d[k] ?? 0) - Number(dist[k])) < 1e-9)) continue;
        const ts = bp.type_scores;
        if (!ts) continue;
        const out: Record<string, number> = {};
        let complete = true;
        for (const k of keys) {
            const v = Number(ts[k]);
            if (Number.isFinite(v) && v > 0) out[k] = v;
            else complete = false;
        }
        if (complete) return out;
    }
    return null;
}

/** Build the complete self-contained A4 print HTML for one quiz. */
export function buildExamPaperHtml(quiz: QuizSetData, opts: ExamPaperOptions): string {
    const style = opts.style;
    const duration = opts.durationMinutes && opts.durationMinutes > 0 ? opts.durationMinutes : styleDuration(style);
    const sections = groupPaperSections(quiz, opts.typeScores);
    // 卷头满分：分值标注卷 = 各节合计（缩抽题后 != 考试原始总分）；否则沿用卷面总分
    const hasAnnotated = sections.some((s) => s.questions.some((it) => questionAnnotatedScore(it.q, opts.typeScores) > 0));
    const totalScore = hasAnnotated
        ? sections.reduce((a, s) => a + s.scoreSum, 0)
        : quiz.total_score > 0
          ? quiz.total_score
          : 100;
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
                    const isChoice = q.question_type === "single_choice" || q.question_type === "multi_choice";
                    h += '<p class="stem"><b>' + number + ".</b>（" + score + " 分" + multiMark + "）" + renderMathText(stripScoreNote(q.question_text)) + (isChoice ? '（<span class="ans-slot"></span>）' : "") + "</p>";
                    if (q.options && q.options.length > 0) {
                        // 自适应排版：短选项（≤10 字）→ 2×2 矩阵；长选项 → 4×1 竖排
                        const maxOptLen = Math.max(...q.options.map((o) => stripOptionLabel(o).length));
                        h += '<div class="options ' + (maxOptLen <= 10 ? "cols-2" : "cols-1") + '">';
                        q.options.forEach((opt, i) => {
                            h +=
                                '<p class="option"><span class="opt-label">' +
                                esc(optionLabel(opt, i)) +
                                "．</span>" +
                                renderMathText(stripOptionLabel(opt)) +
                                "</p>";
                        });
                        h += "</div>";
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
                          if (a) row += "【答案】" + renderMathText(a) + "　";
                          if (q.explanation) row += "【解析】" + renderMathText(q.explanation);
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
<style>${KATEX_INLINE_CSS}</style>
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
  .options { display: grid; gap: 2px 18px; margin: 2px 0 4px 2em; }
  .options.cols-2 { grid-template-columns: 1fr 1fr; }
  .options.cols-1 { grid-template-columns: 1fr; }
  .option { margin: 0; line-height: 1.6; }
  .opt-label { font-weight: 600; }
  .ans-slot { display: inline-block; width: 2.2em; height: 1em; border-bottom: 1px solid #000; vertical-align: baseline; }
  .answers-page { break-before: page; }
  .answers-title { text-align: center; font-family: "SimHei", "黑体", sans-serif; font-size: 14pt; margin: 0 0 12px; }
  .answers-section { margin: 0 0 10px; }
  .answer-row { margin: 0 0 4px; }
  .math-inline { display: inline-block; white-space: normal; }
  .math-display { display: block; text-align: center; margin: 4px 0; }
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
