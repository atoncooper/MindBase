"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Plus_Jakarta_Sans } from "next/font/google";
import { quizApi, type SharedQuizData } from "@/lib/api";
import { SharedQuizView } from "@/components/quiz/SharedQuizView";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--sqv-sans",
  display: "swap",
});

export default function SharedQuizPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [quiz, setQuiz] = useState<SharedQuizData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    quizApi
      .getSharedQuiz(token)
      .then((data) => {
        if (!cancelled) {
          setQuiz(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg =
            err?.message || (err instanceof Error ? err.message : "加载失败");
          setError(msg.includes("404") ? "分享链接无效或已失效" : msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div
      className={`sqv-page ${jakarta.variable}`}
      style={{ fontFamily: "var(--sqv-sans), system-ui, sans-serif" }}
    >
      <div className="sqv-page__bg" aria-hidden />
      <div className="sqv-page__inner">
        {loading && <SharedQuizSkeleton />}
        {!loading && error && <SharedQuizError message={error} />}
        {!loading && !error && quiz && <SharedQuizView quiz={quiz} />}
      </div>
    </div>
  );
}

function SharedQuizSkeleton() {
  return (
    <div className="sqv-skel">
      <div className="sqv-skel__hero">
        <div className="sqv-skel__pill" />
        <div className="sqv-skel__title" />
        <div className="sqv-skel__sub" />
        <div className="sqv-skel__chips">
          <div className="sqv-skel__chip" />
          <div className="sqv-skel__chip" />
        </div>
      </div>
      <div className="sqv-skel__cards">
        <div className="sqv-skel__card" />
        <div className="sqv-skel__card" />
        <div className="sqv-skel__card" />
      </div>
    </div>
  );
}

function SharedQuizError({ message }: { message: string }) {
  return (
    <div className="sqv-error">
      <div className="sqv-error__mark" aria-hidden>
        <svg viewBox="0 0 56 56" width="56" height="56">
          <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M18 30l6 6 14-14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="sqv-error__title">{message}</h1>
      <p className="sqv-error__hint">
        请联系分享者获取新的链接，或登录后查看自己的题目集
      </p>
    </div>
  );
}
