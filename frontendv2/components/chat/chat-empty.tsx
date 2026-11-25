"use client";

import { motion } from "framer-motion";
import { Search, BookOpen, GitCompare, Route } from "lucide-react";

interface EmptyStateProps {
  onSuggestionClick?: (suggestion: string) => void;
}

const suggestions = [
  {
    icon: Search,
    title: "总结收藏内容",
    prompt: "帮我总结一下收藏夹里最有价值的视频内容",
  },
  {
    icon: BookOpen,
    title: "知识检索",
    prompt: "帮我查找与机器学习相关的视频并列出关键知识点",
  },
  {
    icon: GitCompare,
    title: "视频对比",
    prompt: "对比分析几个讲解同一个主题的视频，看看哪个讲得更好",
  },
  {
    icon: Route,
    title: "学习路径",
    prompt: "根据我的收藏视频，帮我规划一个系统的学习路径",
  },
];

export function ChatEmpty({ onSuggestionClick }: EmptyStateProps) {
  return (
    <div className="mx-auto flex h-full max-w-[680px] flex-col items-center justify-center px-4 py-8 text-center sm:px-5 sm:py-10">
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.28, 0.11, 0.32, 1] }}
        className="text-[28px] font-normal tracking-[-0.02em] text-[#0d0d0d] sm:text-[32px]"
      >
        有什么可以帮你？
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1, ease: [0.28, 0.11, 0.32, 1] }}
        className="mt-3 text-[13px] leading-relaxed text-[#8f8f8f] sm:text-[14px]"
      >
        把 B 站收藏夹变成可提问的知识库 · 检索、总结、对比、规划
      </motion.p>

      <div className="mt-6 grid w-full grid-cols-1 gap-2.5 sm:mt-8 sm:grid-cols-2">
        {suggestions.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.button
              key={s.title}
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 + i * 0.06, ease: [0.28, 0.11, 0.32, 1] }}
              whileHover={{ y: -2 }}
              onClick={() => onSuggestionClick?.(s.prompt)}
              className="flex items-start gap-3 rounded-xl border border-[#ececec] bg-white px-4 py-3 text-left transition-colors hover:border-[#d9d9d9] hover:bg-[#f7f7f8]"
              aria-label={`${s.title}：${s.prompt}`}
            >
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-border-subtle text-secondary">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{s.title}</span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-tertiary line-clamp-2">
                  {s.prompt}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
