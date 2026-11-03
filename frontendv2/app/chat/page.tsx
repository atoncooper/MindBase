"use client";

import { use } from "react";
import { ChatView } from "@/components/chat/chat-view";

/**
 * Chat page - 对话主页。
 *
 * 支持 /chat?academic_project=<id>（由科研工作台详情页「在对话中继续」跳入）：
 * 项目 id 透传给 ChatView，请求体带 academic_project_id，后端把受控项目 section
 * 注入系统提示。Next.js 16 的 searchParams 是 Promise，客户端页面用 use() 解包
 * （与 app/graph/page.tsx 同一写法）。
 */
export default function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ academic_project?: string }>;
}) {
  const { academic_project } = use(searchParams);
  return <ChatView academicProjectId={academic_project || undefined} />;
}
