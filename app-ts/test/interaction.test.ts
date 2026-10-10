import { describe, it, expect } from "vitest";
import { createAskUserTool } from "../src/tools/interaction/ask-user.js";
import { ResultCollector } from "../src/context/types.js";
import { encodeFrame } from "../src/transport/sse.js";
import { stopOnToolCall } from "../src/agent/react.js";

const tool = createAskUserTool;

function ctx() {
  return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

const content = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

describe("ask_user tool", () => {
  it("clarify with options → interaction registered, returns short ack", async () => {
    const c = ctx();
    const out = await tool.execute(
      {
        kind: "clarify",
        question: "想搜视频还是云盘文档？",
        options: [
          { label: "搜视频", value: "搜视频" },
          { label: "搜文档", value: "搜文档" },
        ],
      },
      c,
    );
    expect(c.collector.interactions).toHaveLength(1);
    expect(c.collector.interactions[0]).toMatchObject({ kind: "clarify", question: "想搜视频还是云盘文档？" });
    expect(content(out)).toContain("本轮到此结束");
  });

  it("confirm without options → default confirm/cancel pair injected", async () => {
    const c = ctx();
    await tool.execute({ kind: "confirm", question: "删除板子「RAG」？" }, c);
    const payload = c.collector.interactions[0];
    expect(payload.kind).toBe("confirm");
    expect(payload.options).toEqual([
      { label: "确认执行", value: "确认执行" },
      { label: "取消", value: "取消" },
    ]);
  });

  it("clarify without options → rejected with guidance (not thrown)", async () => {
    const c = ctx();
    const out = await tool.execute({ kind: "clarify", question: "？" }, c);
    expect(content(out)).toContain("需要提供 2 个以上选项");
    expect(c.collector.interactions).toHaveLength(0);
  });

  it("form requires fields", async () => {
    const c = ctx();
    const out = await tool.execute({ kind: "form", question: "填写任务信息" }, c);
    expect(content(out)).toContain("需要提供 fields");
    expect(c.collector.interactions).toHaveLength(0);
  });

  it("form with fields → normalized (type/required defaults filled)", async () => {
    const c = ctx();
    await tool.execute(
      {
        kind: "form",
        question: "填写出题任务",
        fields: [
          { name: "topic", label: "出题方向" },
          { name: "email", label: "抄送邮箱", type: "email", required: true },
        ],
      },
      c,
    );
    expect(c.collector.interactions[0].fields).toEqual([
      { name: "topic", label: "出题方向", type: "text", required: false },
      { name: "email", label: "抄送邮箱", type: "email", required: true },
    ]);
  });

  it("second ask_user in the same turn is rejected, first payload kept", async () => {
    const c = ctx();
    await tool.execute(
      {
        kind: "confirm",
        question: "第一问",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      },
      c,
    );
    const out = await tool.execute({ kind: "confirm", question: "第二问" }, c);
    expect(content(out)).toContain("已发起过一次交互");
    expect(c.collector.interactions).toHaveLength(1);
    expect(c.collector.interactions[0].question).toBe("第一问");
  });
});

describe("interact SSE frame", () => {
  it("encodes the payload verbatim for the frontend", () => {
    const wire = encodeFrame({
      type: "interact",
      interact: {
        kind: "confirm",
        question: "删除？",
        options: [{ label: "确认执行", value: "确认执行" }],
      },
    });
    const parsed = JSON.parse(wire.replace(/^data: /, ""));
    expect(parsed.type).toBe("interact");
    expect(parsed.interact.kind).toBe("confirm");
    expect(parsed.interact.options[0].value).toBe("确认执行");
  });
});

describe("stopOnToolCall", () => {
  const steps = (...toolNames: string[][]) =>
    toolNames.map((names) => ({ toolCalls: names.map((toolName) => ({ toolName })) }));

  it("stops once ask_user appeared in any step", () => {
    const stop = stopOnToolCall("ask_user");
    expect(stop({ steps: steps(["vector_search"]) })).toBe(false);
    expect(stop({ steps: steps(["vector_search"], ["ask_user"]) })).toBe(true);
  });

  it("tolerates steps without toolCalls", () => {
    const stop = stopOnToolCall("ask_user");
    expect(stop({ steps: [{}] })).toBe(false);
  });
});
