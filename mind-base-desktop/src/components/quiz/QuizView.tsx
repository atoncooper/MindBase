/**
 * 测验面板：配置 → 出题 → 逐题作答 → 批改结果。
 *
 * 题型交互：single=单选组 / multi=多选组 / short+essay=文本域。
 * 提交后逐题调用 quiz_grade（选择题本地判分、essay 走 LLM 评分），
 * 结果页给出每题对错/得分/解析与总分，可一键再来一组。
 */

import { useEffect, useState } from "react";
import {
  deleteQuizRecord,
  generateQuiz,
  gradeQuestion,
  listQuizRecords,
  saveQuizRecord,
} from "../../lib/quiz";
import type {
  GradeOutcome,
  QuizDifficulty,
  QuizGenEvent,
  QuizQuestion,
  QuizRecord,
  QuizRecordItem,
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

interface AnsweredResult extends GradeOutcome {
  question: QuizQuestion;
  given: string;
}

type Phase = "config" | "generating" | "answering" | "grading" | "results";

function QuizView(): React.JSX.Element {
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuizType[]>(["single_choice", "short_answer"]);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("medium");
  const [topic, setTopic] = useState("");

  const [phase, setPhase] = useState<Phase>("config");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<AnsweredResult[] | null>(null);
  const [error, setError] = useState("");
  /** 生成阶段文案（选题材 → 出题中），随 Channel 事件切换。 */
  const [genStage, setGenStage] = useState("");
  const toast = useToast();
  // 历史记录（测验存档），答完自动刷新。
  const [records, setRecords] = useState<QuizRecord[] | null>(null);
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listQuizRecords().then(
      (rows) => {
        if (!cancelled) setRecords(rows);
      },
      () => {
        if (!cancelled) setRecords([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleType(type: QuizType): void {
    setTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function start(): Promise<void> {
    if (types.length === 0) {
      setError("请至少选择一种题型");
      return;
    }
    setError("");
    setGenStage("正在从知识库选题材…");
    setPhase("generating");
    try {
      const result = await generateQuiz(
        { count, types, difficulty, topic: topic.trim() || undefined },
        (event: QuizGenEvent) => {
          if (event.type === "sampling") setGenStage("正在从知识库选题材…");
          if (event.type === "generating") setGenStage("正在出题（含查重与避旧）…");
        },
      );
      setQuestions(result.questions);
      setAnswers({});
      setResults(null);
      setPhase("answering");
      if (result.duplicatesSkipped > 0) {
        toast.success(
          `已生成 ${result.questions.length} 题（自动去重跳过 ${result.duplicatesSkipped} 道重复）`,
          { title: "出题完成" },
        );
      }
    } catch (err) {
      setError(toErrorMessage(err));
      setPhase("config");
    }
  }

  async function submit(): Promise<void> {
    setPhase("grading");
    setError("");
    const answered: AnsweredResult[] = [];
    try {
      for (const question of questions) {
        const outcome = await gradeQuestion(question, answers[question.questionId] ?? "");
        answered.push({ ...outcome, question, given: answers[question.questionId] ?? "" });
      }
      setResults(answered);
      setPhase("results");
      // 存档本次测验（明细含每题作答与反馈），失败静默——存档不应打断结果页。
      const items: QuizRecordItem[] = answered.map((result) => ({
        questionType: result.question.questionType,
        question: result.question.question,
        given: result.given,
        correct: result.correct,
        score: result.score,
        maxScore: result.maxScore,
        feedback: result.feedback,
      }));
      try {
        await saveQuizRecord(difficulty, items);
        const rows = await listQuizRecords().catch(() => null);
        if (rows !== null) setRecords(rows);
        toast.success("本次测验已存入历史记录", { title: "已存档" });
      } catch (saveErr) {
        console.warn("[quiz] save record failed", saveErr);
      }
    } catch (err) {
      setError(toErrorMessage(err));
      setPhase("answering");
    }
  }

  async function removeRecord(id: string): Promise<void> {
    try {
      await deleteQuizRecord(id);
      setRecords((prev) => (prev ? prev.filter((record) => record.id !== id) : prev));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除失败" });
    }
  }

  // ── config ────────────────────────────────────────────────────────────
  if (phase === "config") {
    return (
      <>
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">QZ</span>知识测验
        </h2>
        <p className="hint-text">从已入库的知识片段出题，即时批改并附解析。</p>

        <div className="cfg-row">
          <span className="cfg-label">题数</span>
          <select
            className="cfg-input quiz-select"
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {[3, 5, 8].map((value) => (
              <option key={value} value={value}>
                {value} 题
              </option>
            ))}
          </select>
        </div>

        <div className="cfg-row">
          <span className="cfg-label">题型</span>
          <div className="quiz-type-row">
            {(Object.keys(TYPE_LABELS) as QuizType[]).map((type) => (
              <label key={type} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={types.includes(type)}
                  onChange={() => toggleType(type)}
                />
                {TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </div>

        <div className="cfg-row">
          <span className="cfg-label">难度</span>
          <div className="quiz-type-row">
            {(Object.keys(DIFF_LABELS) as QuizDifficulty[]).map((level) => (
              <label key={level} className="checkbox-row">
                <input
                  type="radio"
                  name="difficulty"
                  checked={difficulty === level}
                  onChange={() => setDifficulty(level)}
                />
                {DIFF_LABELS[level]}
              </label>
            ))}
          </div>
        </div>

        <div className="cfg-row">
          <span className="cfg-label">主题</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：限定出题主题关键词"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>

        {error !== "" && <p className="error-text">{error}</p>}
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={() => void start()}>
            开始测验
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">⏱</span>历史记录
          <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
            {records !== null ? `${records.length} 次测验` : ""}
          </span>
        </h2>
        {records !== null && records.length === 0 && (
          <p className="hint-text">还没有测验记录。完成一次测验后会自动存档在这里。</p>
        )}
        {records !== null && records.length > 0 && (
          <ul className="ws-docs">
            {records.map((record) => {
              const expanded = expandedRecord === record.id;
              const ratio =
                record.totalMax > 0 ? Math.round((record.totalScore / record.totalMax) * 100) : 0;
              return (
                <li key={record.id} className="ws-doc">
                  <div
                    className="ws-doc__head"
                    style={{ cursor: "pointer" }}
                    onClick={() => setExpandedRecord(expanded ? null : record.id)}
                    title={expanded ? "收起明细" : "展开明细"}
                  >
                    <span className="ws-doc__title">
                      {new Date(record.createdAt * 1000).toLocaleString()}
                    </span>
                    <span className="ws-doc__page-meta">
                      {DIFF_LABELS[record.difficulty as QuizDifficulty] ?? record.difficulty} ·{" "}
                      {record.questionCount} 题 · {record.totalScore.toFixed(1)}/
                      {record.totalMax.toFixed(0)} 分（{ratio}%）
                    </span>
                  </div>
                  <div className="ws-doc__page">
                    <span className="ws-doc__page-meta">
                      {expanded ? "点击标题收起" : "点击标题展开每题明细"}
                    </span>
                    <span className="ws-doc__page-actions">
                      <span className={ratio >= 60 ? "status status--ok" : "status status--error"}>
                        {ratio >= 60 ? "通过" : "未通过"}
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="删除记录"
                        onClick={() => void removeRecord(record.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  {expanded && (
                    <ol className="quiz-results" style={{ marginTop: 8 }}>
                      {record.items.map((item, index) => (
                        <li key={index} className="quiz-result">
                          <div className="quiz-result__head">
                            <span className="quiz-result__q">
                              {index + 1}. {item.question}
                            </span>
                            <span className={item.correct ? "status status--ok" : "status status--error"}>
                              {item.correct ? "✓" : "✗"} {item.score.toFixed(1)}/{item.maxScore.toFixed(0)}
                            </span>
                          </div>
                          <p className="quiz-result__given">
                            我的作答：{item.given !== "" ? item.given : "（未作答）"}
                          </p>
                          {item.feedback !== "" && <p className="quiz-result__feedback">{item.feedback}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      </>
    );
  }

  // ── generating：分阶段进度（选题材 → 出题中） ─────────────────────────
  if (phase === "generating") {
    return (
      <section className="card quiz-pane">
        <p className="placeholder" role="status" aria-live="polite">
          <span className="ingest__spinner" /> {genStage !== "" ? genStage : "正在出题…"}
          （从知识库随机选题材，查重避开已出过的题目）
        </p>
      </section>
    );
  }

  // ── grading spinner ───────────────────────────────────────────────────
  if (phase === "grading") {
    return (
      <section className="card quiz-pane">
        <p className="placeholder">
          批改中…（论述题由 AI 按评分标准打分，可能需要几秒）
        </p>
      </section>
    );
  }

  // ── results ───────────────────────────────────────────────────────────
  if (phase === "results" && results !== null) {
    const totalScore = results.reduce((sum, r) => sum + r.score, 0);
    const totalMax = results.reduce((sum, r) => sum + r.maxScore, 0);
    return (
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">✓</span>测验结果
          <span className={totalScore >= totalMax * 0.6 ? "status status--ok" : "status status--info"}>
            总分 {totalScore.toFixed(1)} / {totalMax.toFixed(0)}
          </span>
        </h2>
        <ol className="quiz-results">
          {results.map((result, index) => (
            <li key={result.questionId} className="quiz-result">
              <div className="quiz-result__head">
                <span className="quiz-result__q">
                  {index + 1}. {result.question.question}
                </span>
                <span className={result.correct ? "status status--ok" : "status status--error"}>
                  {result.score.toFixed(1)} / {result.maxScore.toFixed(0)}
                </span>
              </div>
              <p className="quiz-result__given">
                你的答案：
                {result.given !== "" ? result.given : "（未作答）"}
                {result.question.correctAnswer !== undefined && result.question.options !== undefined && (
                  <>
                    {" "}· 正确：{String(
                      typeof result.question.correctAnswer === "string"
                        ? result.question.correctAnswer
                        : JSON.stringify(result.question.correctAnswer),
                    )}
                  </>
                )}
              </p>
              {result.feedback !== "" && <p className="quiz-result__feedback">{result.feedback}</p>}
              {result.question.explanation !== "" && (
                <p className="quiz-result__explain">解析：{result.question.explanation}</p>
              )}
              {result.question.lowConfidence && (
                <p className="hint-text">⚠ 本题与知识片段匹配度较低，请自行甄别。</p>
              )}
            </li>
          ))}
        </ol>
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={() => setPhase("config")}>
            再来一组
          </button>
        </div>
      </section>
    );
  }

  // ── answering ─────────────────────────────────────────────────────────
  return (
    <section className="card quiz-pane">
      <h2 className="card__title">
        <span className="card__index">QZ</span>答题中 · {questions.length} 题
      </h2>
      {error !== "" && <p className="error-text">{error}</p>}
      <ol className="quiz-questions">
        {questions.map((question, index) => (
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
                      onChange={() =>
                        setAnswers((prev) => ({ ...prev, [question.questionId]: letter }))
                      }
                    />
                    {letter}. {option}
                  </label>
                );
              })}
            {question.questionType === "multi_choice" &&
              (question.options ?? []).map((option, optionIndex) => {
                const letter = String.fromCharCode(65 + optionIndex);
                const current = answers[question.questionId] ?? "";
                const selected = current.includes(letter);
                return (
                  <label key={letter} className="checkbox-row quiz-option">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        const next = selected
                          ? current.split(",").filter((l) => l !== letter)
                          : [...current.split(",").filter(Boolean), letter];
                        setAnswers((prev) => ({
                          ...prev,
                          [question.questionId]: next.sort().join(","),
                        }));
                      }}
                    />
                    {letter}. {option}
                  </label>
                );
              })}
            {(question.questionType === "short_answer" ||
              question.questionType === "essay") && (
              <textarea
                className="note-body__source quiz-free"
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
          </li>
        ))}
      </ol>
      <div className="card__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => void submit()}
        >
          提交全部答案
        </button>
        <button type="button" className="button" onClick={() => setPhase("config")}>
          返回配置
        </button>
      </div>
    </section>
  );
}

export default QuizView;
