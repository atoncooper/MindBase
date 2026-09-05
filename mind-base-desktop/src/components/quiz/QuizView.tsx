/**
 * 测验面板：配置 → 出题 → 历史题集列表。
 *
 * 出题成功即持久化为一个题集（quiz_sets，无论之后答不答），并直接跳转
 * 到该题集的路由页（#/quiz/set/:id）作答；历史列表点任意一次生成的
 * 题目同样跳过去查看 / 继续作答。批改后的成绩存在同一个题集上。
 */

import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { navigate, quizSetHash } from "../../lib/router";
import { createQuizSet, deleteQuizSet, generateQuiz, listQuizSets } from "../../lib/quiz";
import type { QuizDifficulty, QuizGenEvent, QuizSetMeta, QuizType } from "../../lib/quiz";
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

type Phase = "config" | "generating";

function QuizView(): React.JSX.Element {
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuizType[]>(["single_choice", "short_answer"]);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("medium");
  const [topic, setTopic] = useState("");

  const [phase, setPhase] = useState<Phase>("config");
  const [error, setError] = useState("");
  /** 生成阶段文案（选题材 → 出题中），随 Channel 事件切换。 */
  const [genStage, setGenStage] = useState("");
  const toast = useToast();
  // 历史题集（每次生成的批次，答题与否都在）。
  const [sets, setSets] = useState<QuizSetMeta[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listQuizSets().then(
      (rows) => {
        if (!cancelled) setSets(rows);
      },
      () => {
        if (!cancelled) setSets([]);
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
      const request = { count, types, difficulty, topic: topic.trim() || undefined };
      const result = await generateQuiz(request, (event: QuizGenEvent) => {
        if (event.type === "sampling") setGenStage("正在从知识库选题材…");
        if (event.type === "generating") setGenStage("正在出题（含查重与避旧）…");
      });
      if (result.questions.length === 0) {
        setError("模型没有产出可用题目，请重试");
        setPhase("config");
        return;
      }
      // 出题即持久化成题集，然后跳到它的页面作答——之后随时可以从
      // 历史列表回来继续，不依赖组件内存 state。
      const setId = await createQuizSet(request, result.questions);
      navigate(quizSetHash(setId));
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

  async function removeSet(row: QuizSetMeta): Promise<void> {
    // 删除不可恢复（题目、作答、批改结果一并没了），先弹原生对话框确认；
    // window.confirm 在 Tauri WebView 下不可靠，统一走 dialog 插件。
    const confirmed = await confirm(
      `删除 ${new Date(row.createdAt * 1000).toLocaleString()} 生成的这组 ${row.questionCount} 道题？作答与批改结果会一并删除，不可恢复。`,
      { title: "删除题集", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await deleteQuizSet(row.id);
      setSets((prev) => (prev ? prev.filter((item) => item.id !== row.id) : prev));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除失败" });
    }
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

  // ── config + history ─────────────────────────────────────────────────
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
          <span className="card__index">⏱</span>历史题集
          <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
            {sets !== null ? `${sets.length} 次生成` : ""}
          </span>
        </h2>
        {sets !== null && sets.length === 0 && (
          <p className="hint-text">
            还没有生成过题目。每次出题都会保存在这里，点开即可查看或继续作答。
          </p>
        )}
        {sets !== null && sets.length > 0 && (
          <ul className="ws-docs">
            {sets.map((row) => {
              const ratio =
                row.totalMax > 0 ? Math.round((row.totalScore / row.totalMax) * 100) : 0;
              return (
                <li key={row.id} className="ws-doc">
                  <div
                    className="ws-doc__head"
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate(quizSetHash(row.id))}
                    title="点开查看题目"
                  >
                    <span className="ws-doc__title">
                      {new Date(row.createdAt * 1000).toLocaleString()}
                    </span>
                    <span className="ws-doc__page-meta">
                      {DIFF_LABELS[row.difficulty as QuizDifficulty] ?? row.difficulty} ·{" "}
                      {row.questionCount} 题 ·{" "}
                      {row.graded
                        ? `${row.totalScore.toFixed(1)}/${row.totalMax.toFixed(0)} 分（${ratio}%）`
                        : `已答 ${row.answeredCount} / ${row.questionCount}`}
                    </span>
                  </div>
                  <div className="ws-doc__page">
                    <span className="ws-doc__page-meta">
                      {row.graded ? "已批改 · 点击查看" : "进行中 · 点击继续作答"}
                    </span>
                    <span className="ws-doc__page-actions">
                      <span className={row.graded ? (ratio >= 60 ? "status status--ok" : "status status--error") : "status status--info"}>
                        {row.graded ? (ratio >= 60 ? "通过" : "未通过") : "未批改"}
                      </span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="删除题集"
                        onClick={() => void removeSet(row)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export default QuizView;
