/**
 * 单个历史题集页面（#/quiz/set/:id）：查看题目 / 继续作答 / 批改结果。
 *
 * 三种形态：
 * - 未批改（graded=false）：答题交互（与原答题页一致），作答持续落库，
 *   「提交批改」后逐题调 quiz_grade 并 quiz_set_finish 存档。
 * - 已批改（graded=true）：结果页（对错/得分/解析）。
 * - 查看模式开关「显示答案」：对任何题集可随时切换，把每题的正确答案 /
 *   关键词 / 范文 / 解析直接展示在题目下方（默认隐藏，防止误看答案）。
 *
 * 迁移自旧 quiz_records 的记录没有题目原文，只展示批改明细。
 */

import { useEffect, useRef, useState } from "react";
import { navigate, QUIZ_HASH } from "../../lib/router";
import {
  finishQuizSet,
  getQuizSet,
  gradeQuestion,
  saveQuizSetAnswers,
} from "../../lib/quiz";
import type {
  GradeOutcome,
  QuizDifficulty,
  QuizQuestion,
  QuizRecordItem,
  QuizSet,
  QuizType,
} from "../../lib/quiz";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

const TYPE_LABELS: Record<QuizType, string> = {
  single_choice: "单选",
  multi_choice: "多选",
  short_answer: "简答",
  essay: "论述",
};

const DIFF_LABELS: Record<QuizDifficulty, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
};

/** Google Forms 产品图标：紫色页面 + 折角 + 白色「点+行」列表（与测验首页同款）。 */
function GoogleFormsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#7248b9" d="M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5L14.5 2z" />
      <path fill="#d1bcf1" d="M14.5 2 19 6.5h-3.5a1 1 0 0 1-1-1V2z" />
      <g fill="#fff">
        <circle cx="9.4" cy="11.6" r="0.9" />
        <rect x="11.2" y="10.95" width="5.4" height="1.3" rx="0.65" />
        <circle cx="9.4" cy="14.6" r="0.9" />
        <rect x="11.2" y="13.95" width="5.4" height="1.3" rx="0.65" />
        <circle cx="9.4" cy="17.6" r="0.9" />
        <rect x="11.2" y="16.95" width="5.4" height="1.3" rx="0.65" />
      </g>
    </svg>
  );
}

/** Text rendering of a correct answer, whatever shape it takes. */
function answerText(question: QuizQuestion): string {
  if (question.correctAnswer !== undefined) {
    return typeof question.correctAnswer === "string"
      ? question.correctAnswer
      : JSON.stringify(question.correctAnswer);
  }
  if (question.questionType === "short_answer") {
    const keywords = question.keywords.join("、");
    return question.answerTemplate !== undefined && question.answerTemplate !== ""
      ? `${question.answerTemplate}（关键词：${keywords}）`
      : `关键词：${keywords}`;
  }
  if (question.questionType === "essay") {
    return question.modelAnswer ?? "";
  }
  return "";
}

interface Props {
  setId: string;
}

function QuizSetView({ setId }: Props): React.JSX.Element {
  const [set, setSet] = useState<QuizSet | null>(null);
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState<"loading" | "answering" | "grading" | "results">("loading");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showAnswers, setShowAnswers] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void getQuizSet(setId).then(
      (loaded) => {
        if (cancelled) return;
        if (loaded === null) {
          setLoadError("题集不存在或已删除。");
          setPhase("loading");
          return;
        }
        setSet(loaded);
        setAnswers(loaded.answers);
        setPhase(loaded.graded ? "results" : "answering");
      },
      (err) => {
        if (!cancelled) setLoadError(toErrorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [setId]);

  // 作答中持续写库；防抖 400ms，避免每个按键都写库。
  useEffect(() => {
    if (phase !== "answering" || set === null || set.graded) return;
    const timer = window.setTimeout(() => {
      void saveQuizSetAnswers(set.id, answers).catch((err) =>
        console.warn("[quiz] save answers failed", err),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [phase, set, answers]);

  // 离开作答（提交批改 / 切页）时立即补写一次，防抖窗口内的输入不丢。
  const latestRef = useRef({ phase, set, answers });
  latestRef.current = { phase, set, answers };
  useEffect(() => {
    return () => {
      const snap = latestRef.current;
      if (snap.phase !== "answering" || snap.set === null || snap.set.graded) return;
      void saveQuizSetAnswers(snap.set.id, snap.answers).catch((err) =>
        console.warn("[quiz] save answers on unmount failed", err),
      );
    };
  }, []);

  async function submit(): Promise<void> {
    if (set === null) return;
    setPhase("grading");
    setError("");
    const items: QuizRecordItem[] = [];
    try {
      for (const question of set.questions) {
        const outcome: GradeOutcome = await gradeQuestion(
          question,
          answers[question.questionId] ?? "",
        );
        items.push({
          questionType: question.questionType,
          question: question.question,
          given: answers[question.questionId] ?? "",
          correct: outcome.correct,
          score: outcome.score,
          maxScore: outcome.maxScore,
          feedback: outcome.feedback,
        });
      }
      await finishQuizSet(set.id, items);
      const refreshed = await getQuizSet(set.id).catch(() => null);
      if (refreshed !== null) {
        setSet(refreshed);
        setAnswers(refreshed.answers);
      }
      setPhase("results");
      toast.success("批改完成，结果已存档", { title: "已批改" });
    } catch (err) {
      setError(toErrorMessage(err));
      setPhase("answering");
    }
  }

  function toggleAnswer(questionId: string, letter: string): void {
    setAnswers((prev) => ({ ...prev, [questionId]: letter }));
  }

  function toggleMultiAnswer(questionId: string, letter: string): void {
    setAnswers((prev) => {
      const current = prev[questionId] ?? "";
      const letters = current.split(",").filter(Boolean);
      const next = letters.includes(letter)
        ? letters.filter((l) => l !== letter)
        : [...letters, letter];
      return { ...prev, [questionId]: next.sort().join(",") };
    });
  }

  // ── loading / error ─────────────────────────────────────────────────────
  if (set === null) {
    return (
      <div className="gen-layout">
        <section className="card quiz-pane">
          {loadError !== "" ? (
            <>
              <p className="error-text">{loadError}</p>
              <div className="card__actions">
                <button type="button" className="button" onClick={() => navigate(QUIZ_HASH)}>
                  返回测验
                </button>
              </div>
            </>
          ) : (
            <p className="placeholder">
              <span className="ingest__spinner" /> 正在加载题集…
            </p>
          )}
        </section>
      </div>
    );
  }

  const graded = set.graded && set.results.length > 0;
  // 旧 quiz_records 迁移来的行没有题目原文，只能展示批改明细。
  const migrated = set.questions.length === 0;
  const totalScore = graded ? set.totalScore : 0;
  const totalMax = graded ? set.totalMax : 0;

  // ── results（已批改）───────────────────────────────────────────────────
  if (graded || migrated) {
    return (
      <div className="gen-layout">
        <section className="card quiz-pane quiz-page">
          <div className="gen-hero">
            <span className="gen-hero__icon" aria-hidden="true">
              <GoogleFormsIcon />
            </span>
            <div className="gen-hero__text">
              <h2 className="gen-hero__title">测验结果</h2>
              <p className="gen-hero__sub">
                {new Date(set.createdAt * 1000).toLocaleString()} · {set.questionCount} 题
              </p>
            </div>
          </div>

          {graded && (
            <div className="quiz-score">
              <span className="quiz-score__value">
                {totalScore.toFixed(1)}
                <small> / {totalMax.toFixed(0)}</small>
              </span>
              <span className={totalScore >= totalMax * 0.6 ? "status status--ok" : "status status--error"}>
                {totalScore >= totalMax * 0.6 ? "通过" : "未通过"}（及格线 60%）
              </span>
            </div>
          )}

          <div className="quiz-field">
            <span className="quiz-field__label">答案</span>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={showAnswers}
                onChange={() => setShowAnswers((value) => !value)}
              />
              显示答案与解析（默认隐藏）
            </label>
          </div>

          {graded && (
            <ol className="quiz-results">
              {set.results.map((item, index) => {
                const question = set.questions[index];
                return (
                  <li key={index} className="quiz-result">
                    <div className="quiz-result__head">
                      <span className="quiz-result__q">
                        {index + 1}. [{TYPE_LABELS[item.questionType] ?? item.questionType}]{" "}
                        {item.question}
                      </span>
                      <span className={item.correct ? "status status--ok" : "status status--error"}>
                        {item.score.toFixed(1)} / {item.maxScore.toFixed(0)}
                      </span>
                    </div>
                    <p className="quiz-result__given">
                      你的答案：{item.given !== "" ? item.given : "（未作答）"}
                    </p>
                    {showAnswers && question !== undefined && (
                      <p className="quiz-result__explain">正确答案：{answerText(question)}</p>
                    )}
                    {item.feedback !== "" && <p className="quiz-result__feedback">{item.feedback}</p>}
                    {showAnswers && question !== undefined && question.explanation !== "" && (
                      <p className="quiz-result__explain">解析：{question.explanation}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {migrated && (
            <p className="hint-text">
              这条记录来自旧版本的测验存档，只保留了批改明细，题目原文没有保存。
            </p>
          )}

          <div className="card__actions">
            <button type="button" className="button" onClick={() => navigate(QUIZ_HASH)}>
              返回测验
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ── grading spinner ─────────────────────────────────────────────────────
  if (phase === "grading") {
    return (
      <div className="gen-layout">
        <section className="card quiz-pane">
          <p className="placeholder">
            批改中…（论述题由 AI 按评分标准打分，可能需要几秒）
          </p>
        </section>
      </div>
    );
  }

  // ── answering（未批改）────────────────────────────────────────────────
  return (
    <div className="gen-layout">
      <section className="card quiz-pane quiz-page">
        <div className="gen-hero">
          <span className="gen-hero__icon" aria-hidden="true">
            <GoogleFormsIcon />
          </span>
          <div className="gen-hero__text">
            <h2 className="gen-hero__title">答题中 · {set.questions.length} 题</h2>
            <p className="gen-hero__sub">
              {new Date(set.createdAt * 1000).toLocaleString()} · 作答自动保存
            </p>
          </div>
        </div>

        <div className="quiz-field">
          <span className="quiz-field__label">答案</span>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showAnswers}
              onChange={() => setShowAnswers((value) => !value)}
            />
            显示答案与解析（默认隐藏）
          </label>
        </div>

        {error !== "" && <p className="error-text">{error}</p>}
        <ol className="quiz-questions">
          {set.questions.map((question, index) => (
            <li key={question.questionId} className="quiz-question">
              <p className="quiz-question__stem">
                {index + 1}. [{TYPE_LABELS[question.questionType]} ·{" "}
                {DIFF_LABELS[question.difficulty as QuizDifficulty] ?? question.difficulty}]{" "}
                {question.question}
              </p>
              {question.questionType === "single_choice" &&
                (question.options ?? []).map((option, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex);
                  return (
                    <label key={letter} className="checkbox-row quiz-option">
                      <input
                        type="radio"
                        name={question.questionId}
                        checked={(answers[question.questionId] ?? "") === letter}
                        onChange={() => toggleAnswer(question.questionId, letter)}
                      />
                      <span className="quiz-option__text">
                        {letter}. {option}
                      </span>
                    </label>
                  );
                })}
              {question.questionType === "multi_choice" &&
                (question.options ?? []).map((option, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex);
                  const selected = (answers[question.questionId] ?? "").includes(letter);
                  return (
                    <label key={letter} className="checkbox-row quiz-option">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleMultiAnswer(question.questionId, letter)}
                      />
                      <span className="quiz-option__text">
                        {letter}. {option}
                      </span>
                    </label>
                  );
                })}
              {(question.questionType === "short_answer" ||
                question.questionType === "essay") && (
                <textarea
                  className="quiz-free"
                  rows={question.questionType === "essay" ? 5 : 2}
                  placeholder="输入你的回答…"
                  value={answers[question.questionId] ?? ""}
                  onChange={(event) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [question.questionId]: event.target.value,
                    }))
                  }
                />
              )}
              {showAnswers && (
                <p className="quiz-result__explain">答案：{answerText(question)}</p>
              )}
              {showAnswers && question.explanation !== "" && (
                <p className="quiz-result__explain">解析：{question.explanation}</p>
              )}
            </li>
          ))}
        </ol>
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={() => void submit()}>
            提交批改
          </button>
          <button type="button" className="button" onClick={() => navigate(QUIZ_HASH)}>
            返回列表（作答已保存）
          </button>
        </div>
      </section>
    </div>
  );
}

export default QuizSetView;
