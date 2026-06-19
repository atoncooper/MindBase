"use client";

interface EmptyStateProps {
  onSuggestionClick?: (suggestion: string) => void;
}

const suggestions = [
  {
    index: "01",
    accent: "blue",
    title: "总结收藏内容",
    prompt: "帮我总结一下收藏夹里最有价值的视频内容",
  },
  {
    index: "02",
    accent: "teal",
    title: "知识检索",
    prompt: "帮我查找与机器学习相关的视频并列出关键知识点",
  },
  {
    index: "03",
    accent: "amber",
    title: "视频对比",
    prompt: "对比分析几个讲解同一个主题的视频，看看哪个讲得更好",
  },
  {
    index: "04",
    accent: "violet",
    title: "学习路径",
    prompt: "根据我的收藏视频，帮我规划一个系统的学习路径",
  },
];

export default function EmptyState({ onSuggestionClick }: EmptyStateProps) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-kicker">BiliRag · 知识库已就绪</div>
      <h1 className="chat-empty-heading">
        <span className="chat-empty-heading-light">你好，</span>
        <span className="chat-empty-heading-bold">有什么可以帮你？</span>
      </h1>
      <p className="chat-empty-subtitle">
        把 B 站收藏夹变成可提问的知识库 — 检索、总结、对比、规划。
      </p>

      <div className="chat-suggestion-grid" role="group" aria-label="快捷建议">
        {suggestions.map((s) => (
          <button
            key={s.index}
            type="button"
            className="chat-suggestion-card"
            data-accent={s.accent}
            onClick={() => onSuggestionClick?.(s.prompt)}
            aria-label={`${s.title}：${s.prompt}`}
          >
            <span className="chat-suggestion-index" aria-hidden="true">
              {s.index}
            </span>
            <div className="chat-suggestion-body">
              <div className="chat-suggestion-title">{s.title}</div>
              <div className="chat-suggestion-prompt">{s.prompt}</div>
            </div>
            <span className="chat-suggestion-arrow" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
