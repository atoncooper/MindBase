# Google Gemini 风格聊天组件

## 概述

将原有的 ChatPanel 改造为类似 Google Gemini 界面风格的聊天组件，包含更现代化的视觉设计和更好的用户体验。

## 组件架构

```
components/chat/
├── ChatPanel.tsx              # 完整页面聊天面板（独立路由 /chat）
├── ChatDockPanel.tsx          # Dock 模式聊天面板（集成到主界面）
├── ChatMessage.tsx            # 消息气泡组件
├── ChatInput.tsx              # 输入框组件
├── ChatHeader.tsx             # 顶部标题栏
├── ChatHistorySidebar.tsx     # 历史会话侧边栏
├── EmptyState.tsx             # 空状态欢迎页
└── index.ts                   # 统一导出
```

## 设计特点

### 视觉风格
- **配色**: 使用 Google Blue (#4285F4) 作为主色调
- **圆角**: 大圆角设计（24px），营造柔和感
- **阴影**: 多层级阴影系统，模拟 Material Design 3
- **留白**: 充足的留白，提升可读性

### 消息气泡
- 用户消息: 右侧对齐，浅蓝色背景 (#E8F0FE)
- Assistant 消息: 左侧对齐，浅灰背景 (#F8F9FA)
- Markdown 渲染支持代码高亮、表格、引用

### 交互特性
- ✅ 流式打字效果
- ✅ 思考过程折叠/展开
- ✅ 来源链接展示
- ✅ 消息复制功能
- ✅ 快捷问题推荐（空状态）
- ✅ 历史会话侧边栏
- ✅ 会话分组（今天/昨天/上周/更早）

## 使用方式

### 1. 独立聊天页面
访问 `/chat` 路由即可打开完整的 Gemini 风格聊天界面：

```tsx
// app/chat/page.tsx
import ChatPanel from "@/components/chat/ChatPanel";

export default function ChatPage() {
  return (
    <div className="min-h-screen bg-[var(--gemini-surface)]">
      <ChatPanel />
    </div>
  );
}
```

### 2. Dock 面板集成
在主界面 Dock 栏中点击「对话」图标，弹出聊天面板：

```tsx
// dock-modules/index.ts
import ChatDockPanel from "@/components/chat/ChatDockPanel";

export const dockModules: DockModule[] = [
  {
    id: "chat",
    icon: MessageCircle,
    title: "对话",
    panel: ChatDockPanel,
    defaultSize: { width: 1156, height: 680 },
  },
  // ...
];
```

## CSS 变量

新增 Gemini 风格 CSS 变量（位于 `app/globals.css`）：

```css
:root {
  --gemini-primary: #4285F4;           /* Google Blue */
  --gemini-primary-hover: #3367D6;
  --gemini-surface: #FFFFFF;
  --gemini-surface-variant: #F8F9FA;
  --gemini-border: #DADCE0;
  --gemini-border-subtle: #F1F3F4;
  --gemini-text-primary: #202124;
  --gemini-text-secondary: #5F6368;
  --gemini-text-tertiary: #70757A;
  --gemini-user-bubble: #E8F0FE;
  --gemini-assistant-bubble: #F8F9FA;
  --gemini-radius: 24px;
  --gemini-radius-sm: 12px;
}
```

## 主要改进

### 相比原有 ChatPanel

1. **视觉升级**: 全新 Material Design 3 风格
2. **组件拆分**: 单一职责原则，每个组件 < 200 行
3. **更好的 Markdown**: 代码高亮、表格、引用支持
4. **空状态**: 美观的欢迎页 + 快捷问题推荐
5. **侧边栏**: 完整的历史会话管理
6. **动画效果**: 流式输出、消息出现动画

## 后续优化建议

- [ ] 暗黑模式适配
- [ ] 消息搜索功能
- [ ] 拖拽上传文件
- [ ] 语音输入/输出
- [ ] 消息编辑/重新生成
- [ ] 会话标签/分类管理
