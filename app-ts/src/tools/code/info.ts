import { defineTool } from "../base.js";
import type { CodeInfoPort } from "./code-execution.js";

/** sandbox_info: static runtime contract so the model stops guessing capabilities. */
export function createSandboxInfoTool(execution: CodeInfoPort) {
  return defineTool({
    name: "sandbox_info",
    description:
      "查询当前代码沙箱的镜像、CPU/内存、网络策略和 app-sandbox 接受的 language 列表。" +
      "写代码前先调用，避免使用镜像中不存在的 bash/node/pwsh 或科学计算包。",
    inputSchema: {} as Record<string, unknown>,
    defaultTimeoutMs: 15_000,
    async execute(_args, _ctx, signal) {
      try {
        const info = await execution.getInfo(signal);
        return [
          "runtime: " + info.runtime,
          "image: " + info.image,
          "cpu: " + info.cpu,
          "memory: " + info.memory,
          "network_default_action: " + info.networkDefaultAction,
          "egress_allow: " + (info.egressAllow.length > 0 ? info.egressAllow.join(",") : "(none)"),
          "accepted_languages: " + info.acceptedLanguages.join(", "),
          "notes:",
          ...info.notes.map((note) => "- " + note),
        ].join("\n");
      } catch (error) {
        return "查询沙箱信息失败：" + (error instanceof Error ? error.message : String(error));
      }
    },
  });
}
