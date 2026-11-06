"use client";

// Lab prototype page: a mocked conversation that renders the production
// interactive-artifact cards (same components the chat uses), so the demo and
// the real chat cannot drift apart. Open /lab/interactive to try it.

import { InteractiveArtifact } from "@/components/chat/artifacts/interactive-artifact";
import { DEMO_DIAGRAM, DEMO_PLOT } from "@/lib/lab/demo-specs";

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14px] leading-relaxed text-accent-foreground">
        {children}
      </div>
    </div>
  );
}

function AssistantBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-medium text-accent">
        AI
      </span>
      <div className="min-w-0 flex-1 text-[14px] leading-relaxed text-foreground">{children}</div>
    </div>
  );
}

export function InteractiveArtifactDemo() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="border-b border-border-subtle pb-5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-tertiary">Lab · 原型验证</p>
        <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-foreground">对话里的交互式产物</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-secondary">
          模型不再只会输出文字：它可以产出「可交互的组件」。下面两张卡片用的是正式聊天里的同一套渲染器——
          流程图可以滚轮缩放、拖拽平移；函数图像可以拖动参数实时变形。点开「模型输出」能看到模型实际发出的结构化数据（而不是任意 HTML）。
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {["结构化 spec（服务端校验）", "无 iframe / 无任意脚本执行", "可全屏、可下载 .drawio", "刷新后仍保留（已持久化）"].map((tag) => (
            <span key={tag} className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-secondary">
              {tag}
            </span>
          ))}
        </div>
      </header>

      <UserBubble>把 MindBase 的检索链路画成一张流程图，我想自己拖着看细节。</UserBubble>

      <AssistantBlock>
        <p className="mb-1">
          画好了。这张图可以直接滚轮缩放、按住拖拽，右上角「适应」会重新框选全图，也可以全屏看；需要编辑就点「.drawio」下载。
        </p>
        <InteractiveArtifact kind="diagram" data={DEMO_DIAGRAM} />
      </AssistantBlock>

      <UserBubble>再用图像解释 y = a·sin(bx + c) + d 里每个参数的作用，最好能直接拖着看。</UserBubble>

      <AssistantBlock>
        <p className="mb-1">
          下面这张图把 a/b/c/d 做成了滑块：拖动 a 看振幅、b 看频率、c 看相位、d 看上下平移，橙色曲线是它的导数。
        </p>
        <InteractiveArtifact kind="plot" data={DEMO_PLOT} />
      </AssistantBlock>

      <div className="rounded-xl border border-border-subtle bg-[#f5f5f7] p-3.5 text-[12px] leading-relaxed text-secondary">
        <p className="font-medium text-foreground">它是怎么来的？</p>
        <p className="mt-1">
          agent 侧 <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">render_plot</code> /{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">render_diagram</code> 工具校验 spec 后推入
          ResultCollector；已有的 <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">artifact</code> SSE 帧把{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">{"{ kind, data }"}</code> 带到前端，
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">ArtifactCard</code> 按 kind 分发到这里；
          回合结束时同一份数据写入消息记录，刷新历史仍会显示。协议与安全边界见{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px]">plan/research-interactive-ui/</code>。
        </p>
      </div>
    </div>
  );
}
