"use client";

import { use } from "react";
import { ChatView } from "@/components/chat/chat-view";

/**
 * Chat page - 对话主页。
 *
 * 支持两种带上下文的入口：
 * - /chat?academic_project=<id>（科研工作台详情页「在对话中继续」）：透传项目 id，
 *   请求体带 academic_project_id，后端把受控项目 section 注入系统提示；
 * - /chat?upload_uuid=<uuid>（云盘文件详情「问这份文件」）：透传文件 uuid，
 *   请求体带 scope.uploadUuids，回答只基于该云盘文件。
 * Next.js 16 的 searchParams 是 Promise，客户端页面用 use() 解包
 * （与 app/graph/page.tsx 同一写法）。
 */
export default function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ academic_project?: string; upload_uuid?: string }>;
}) {
  const { academic_project, upload_uuid } = use(searchParams);
  return (
    <ChatView
      academicProjectId={academic_project || undefined}
      uploadUuid={upload_uuid || undefined}
    />
  );
}
