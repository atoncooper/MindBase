"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ChatView } from "@/components/chat/chat-view";

/**
 * Chat page - 对话主页。
 *
 * 支持两种带上下文的入口（用 useSearchParams 读取，客户端导航/静态路由都可靠；
 * 不能用页面的 searchParams prop——/chat 是静态预渲染路由，prop 拿不到实际查询串）：
 * - /chat?academic_project=<id>[&new=1]（科研工作台「在对话中继续」）：透传项目 id，
 *   请求体带 academic_project_id，后端把受控项目 section 注入系统提示；new=1 表示
 *   进入时进入**草稿态**新建对话（不影响已有会话；发出第一条消息才在服务端创建）。
 *   草稿携带的项目会绑定到新会话上（重开历史会话仍保留）；侧栏「开启新对话」右侧
 *   箭头也可选择普通对话或绑定项目。
 * - /chat?upload_uuid=<uuid>（云盘文件详情「问这份文件」）：透传文件 uuid，
 *   请求体带 scope.uploadUuids，回答只基于该云盘文件。
 */
function ChatPageInner() {
  const searchParams = useSearchParams();
  const academicProjectId = searchParams.get("academic_project") || undefined;
  const uploadUuid = searchParams.get("upload_uuid") || undefined;
  const startNew = searchParams.get("new") === "1";
  return (
    <ChatView
      academicProjectId={academicProjectId}
      uploadUuid={uploadUuid}
      startNew={startNew}
    />
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}
