"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { useTheme } from "@/components/ThemeProvider";
import type { SharedQuizData, SharedQuizQuestion } from "@/lib/api";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--sqv-sans",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--sqv-mono",
  display: "swap",
});

interface SharedQuizViewProps {
  quiz: SharedQuizData;
}

const TYPE_LABEL: Record<string, string> = {
  single_choice: "单选题",
  multi_choice: "多选题",
  true_false: "判断题",
  short_answer: "简答题",
  essay: "论述题",
};

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "基础",
  medium: "进阶",
  hard: "挑战",
};

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 1.5v2M10 16.5v2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M1.5 10h2M16.5 10h2M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
      <path d="M17.3 13.5a7.4 7.4 0 0 1-9.8-9.8 7.4 7.4 0 1 0 9.8 9.8Z" />
    </svg>
  );
}

export function SharedQuizView({ quiz }: SharedQuizViewProps) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const { theme, toggle } = useTheme();

  const totalAnswered = useMemo(
    () =>
      Object.values(answers).filter(
        (v) =>
          v !== undefined &&
          v !== "" &&
          !(Array.isArray(v) && v.length === 0),
      ).length,
    [answers],
  );

  const typeDistribution = useMemo(() => {
    const dist: Record<string, number> = {};
    for (const q of quiz.questions) {
      dist[q.question_type] = (dist[q.question_type] ?? 0) + 1;
    }
    return dist;
  }, [quiz.questions]);

  const onSelectSingle = (qUuid: string, option: string) => {
    setAnswers((prev) => ({ ...prev, [qUuid]: option }));
  };
  const onSelectMulti = (qUuid: string, option: string) => {
    setAnswers((prev) => {
      const cur = Array.isArray(prev[qUuid]) ? (prev[qUuid] as string[]) : [];
      const next = cur.includes(option)
        ? cur.filter((x) => x !== option)
        : [...cur, option];
      return { ...prev, [qUuid]: next };
    });
  };
  const onTextChange = (qUuid: string, text: string) => {
    setAnswers((prev) => ({ ...prev, [qUuid]: text }));
  };

  const sharedAt = quiz.shared_at ? new Date(quiz.shared_at) : null;
  const progress =
    quiz.questions.length === 0
      ? 0
      : Math.round((totalAnswered / quiz.questions.length) * 100);

  return (
    <div className={`sqv-root ${jakarta.variable} ${jetbrains.variable}`}>
      {/* ── Theme toggle (floating, Apple style) ──── */}
      <button
        type="button"
        onClick={toggle}
        className="sqv-theme-toggle"
        aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
        title={theme === "dark" ? "浅色模式" : "深色模式"}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      {/* ── Hero ───────────────────────────────────── */}
      <header className="sqv-hero">
        <div className="sqv-hero__inner">
          <span className="sqv-eyebrow">
            <span className="sqv-eyebrow__dot" />
            共享题目集
          </span>

          <h1 className="sqv-hero__title">{quiz.title}</h1>

          <p className="sqv-hero__subtitle">
            {quiz.question_count} 道题目
            {quiz.total_score > 0 && ` · 满分 ${quiz.total_score}`}
            {sharedAt &&
              ` · ${sharedAt.getFullYear()} 年 ${sharedAt.getMonth() + 1} 月 ${sharedAt.getDate()} 日分享`}
          </p>

          <div className="sqv-hero__chips">
            <span className="sqv-chip">
              {DIFFICULTY_LABEL[quiz.difficulty] ?? quiz.difficulty}
            </span>
            {Object.entries(typeDistribution).map(([t, n]) => (
              <span key={t} className="sqv-chip sqv-chip--ghost">
                {TYPE_LABEL[t] ?? t}
                <span className="sqv-chip__count">{n}</span>
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* ── Questions ──────────────────────────────── */}
      <section className="sqv-list">
        {quiz.questions.map((q, idx) => (
          <QuestionCard
            key={q.question_uuid}
            index={idx + 1}
            question={q}
            answer={answers[q.question_uuid]}
            onSelectSingle={(opt) => onSelectSingle(q.question_uuid, opt)}
            onSelectMulti={(opt) => onSelectMulti(q.question_uuid, opt)}
            onTextChange={(text) => onTextChange(q.question_uuid, text)}
          />
        ))}
      </section>

      {/* ── Foot note ──────────────────────────────── */}
      <div className="sqv-footnote">
        <p>
          此为分享自测视图，仅展示题目。正确答案与解析不公开，
          你的作答保留在浏览器内，不会上传。
        </p>
      </div>

      {/* ── Sticky progress (Apple solid bar) ─────── */}
      <div className="sqv-dock">
        <div className="sqv-dock__inner">
          <div className="sqv-dock__count">
            <span className="sqv-dock__done">{totalAnswered}</span>
            <span className="sqv-dock__sep">/</span>
            <span className="sqv-dock__total">{quiz.questions.length}</span>
            <span className="sqv-dock__label">已作答 · {progress}%</span>
          </div>
          <div className="sqv-dock__bar" aria-hidden>
            <div
              className="sqv-dock__fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <button
            type="button"
            className="sqv-dock__submit"
            disabled
            title="分享视图不提交批改"
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}

interface QuestionCardProps {
  index: number;
  question: SharedQuizQuestion;
  answer: string | string[] | undefined;
  onSelectSingle: (option: string) => void;
  onSelectMulti: (option: string) => void;
  onTextChange: (text: string) => void;
}

function QuestionCard({
  index,
  question,
  answer,
  onSelectSingle,
  onSelectMulti,
  onTextChange,
}: QuestionCardProps) {
  const qType = question.question_type;
  const options = normalizeOptions(question.options);
  const isMulti = qType === "multi_choice";
  const isText = qType === "short_answer" || qType === "essay";

  const selectedSet = useMemo(
    () => new Set(Array.isArray(answer) ? answer : []),
    [answer],
  );
  const hasAnswer = isMulti
    ? selectedSet.size > 0
    : isText
      ? typeof answer === "string" && answer.trim() !== ""
      : typeof answer === "string" && answer !== "";

  return (
    <article className={`sqv-q ${hasAnswer ? "sqv-q--done" : ""}`}>
      <div className="sqv-q__head">
        <span className="sqv-q__num">第 {index} 题</span>
        <span className="sqv-q__dot" aria-hidden />
        <span className="sqv-q__type">
          {TYPE_LABEL[qType] ?? qType}
        </span>
        {question.difficulty && (
          <>
            <span className="sqv-q__dot" aria-hidden />
            <span className="sqv-q__diff">
              {DIFFICULTY_LABEL[question.difficulty] ?? question.difficulty}
            </span>
          </>
        )}
      </div>

      <p className="sqv-q__text">{question.question_text}</p>

      {isText ? (
        <textarea
          className="sqv-textarea"
          rows={4}
          placeholder="在此作答（分享视图不提交）"
          value={typeof answer === "string" ? answer : ""}
          onChange={(e) => onTextChange(e.target.value)}
        />
      ) : options.length > 0 ? (
        <ul className="sqv-options">
          {options.map((opt) => {
            const checked = isMulti
              ? selectedSet.has(opt.value)
              : (answer as string | undefined) === opt.value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  className={`sqv-opt ${checked ? "sqv-opt--on" : ""}`}
                  onClick={() =>
                    isMulti ? onSelectMulti(opt.value) : onSelectSingle(opt.value)
                  }
                  aria-pressed={checked}
                >
                  <span className="sqv-opt__letter">{opt.label}</span>
                  <span className="sqv-opt__text">{opt.text}</span>
                  <span className="sqv-opt__check" aria-hidden>
                    {isMulti ? (
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path
                          d="M3.5 8.5l3 3 6-7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <span className="sqv-opt__radio" />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

interface NormalizedOption {
  label: string;
  value: string;
  text: string;
}

function normalizeOptions(
  options: SharedQuizQuestion["options"],
): NormalizedOption[] {
  if (!options) return [];
  if (Array.isArray(options)) {
    return options.map((opt, i) => {
      const label = String.fromCharCode(65 + i);
      return { label, value: label, text: typeof opt === "string" ? opt : String(opt) };
    });
  }
  if (typeof options === "object") {
    return Object.entries(options).map(([key, val]) => ({
      label: key,
      value: key,
      text: typeof val === "string" ? val : String(val),
    }));
  }
  return [];
}
