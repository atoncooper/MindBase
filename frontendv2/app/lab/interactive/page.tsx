import type { Metadata } from "next";
import { InteractiveArtifactDemo } from "@/components/lab/interactive-demo";

export const metadata: Metadata = {
  title: "交互式产物原型 · MindBase",
  description: "AI 对话中可缩放的流程图与可调参数的函数图像原型",
};

export default function InteractiveArtifactLabPage() {
  return (
    <main className="min-h-screen bg-background">
      <InteractiveArtifactDemo />
    </main>
  );
}
