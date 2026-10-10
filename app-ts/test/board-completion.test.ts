import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import {
  BoardCompletionError,
  BoardCompletionService,
  buildPrompt,
  findAnchor,
  findParent,
  normalizeSuggestions,
  parseBoardDoc,
} from "../src/services/board-completion.js";
import type { McpCallResult } from "../src/mcp/index.js";

/**
 * Board completion port (app/services/board/completion.py → services/board-completion.ts):
 * anchor lookup, structured-output normalization, HTTP status mapping and the
 * per-uid rate limit are the behaviors the Python router+service owned.
 */

const fakeModel = {} as unknown as LanguageModel;

interface Captured {
  tool: string;
  args: Record<string, unknown>;
  uid?: number;
}

function fakeClient(board: unknown, calls: Captured[] = [], fail = false) {
  return {
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      opts?: { uid?: number },
    ): Promise<McpCallResult> => {
      calls.push({ tool: name, args, uid: opts?.uid });
      if (fail) return { ok: false, content: "", error: "HTTP 500", errorKind: "transport" as const };
      return { ok: true, content: JSON.stringify(board) };
    },
  };
}

function boardDoc(root: unknown): string {
  return JSON.stringify({ uuid: "b-1", title: "测试导图", content: JSON.stringify({ root }) });
}

const anchorTree = {
  data: { uid: "root", text: "根" },
  children: [
    { data: { uid: "a-1", text: "锚点节点" }, children: [] },
    { data: { uid: "b-1", text: "同级节点" } },
  ],
};

function makeService(client: ReturnType<typeof fakeClient>, object: unknown, calls: unknown[] = []) {
  return new BoardCompletionService({
    client,
    model: fakeModel,
    generate: async () => {
      calls.push(object);
      return { object };
    },
  });
}

describe("board completion helpers", () => {
  it("parseBoardDoc: JSON string / object / invalid", () => {
    expect(parseBoardDoc(JSON.stringify({ root: { a: 1 } }))).toEqual({ root: { a: 1 } });
    expect(parseBoardDoc({ root: {} })).toEqual({ root: {} });
    expect(parseBoardDoc("not-json")).toEqual({});
    expect(parseBoardDoc([1, 2])).toEqual({});
    expect(parseBoardDoc(null)).toEqual({});
  });

  it("findAnchor: prefers uid, falls back to text", () => {
    const root = JSON.parse(JSON.stringify(anchorTree)) as Record<string, unknown>;
    expect(findAnchor(root, "a-1", "")).toEqual(anchorTree.children[0]);
    expect(findAnchor(root, "", "同级节点")).toEqual(anchorTree.children[1]);
    expect(findAnchor(root, "missing", "also-missing")).toBeNull();
  });

  it("findParent: identity match on the tree", () => {
    const root = JSON.parse(JSON.stringify(anchorTree)) as Record<string, unknown>;
    const children = root.children as Array<Record<string, unknown>>;
    expect(findParent(root, children[0])).toBe(root);
    expect(findParent(children[0], children[1])).toBeNull();
  });

  it("normalizeSuggestions: code/md downgrade + empty text dropped", () => {
    const out = normalizeSuggestions([
      { text: "纯文本", reason: "", kind: "text", code: "", language: "", markdown: "" },
      { text: "代码", reason: "r", kind: "code", code: "print(1)", language: "python", markdown: "" },
      { text: "空代码降级", reason: "", kind: "code", code: "   ", language: "", markdown: "" },
      { text: "Markdown", reason: "", kind: "md", code: "", language: "", markdown: "# 标题" },
      { text: "", reason: "", kind: "text", code: "", language: "", markdown: "" },
      { text: "未知类型", reason: "", kind: "weird", code: "", language: "", markdown: "" },
    ]);
    expect(out.map((s) => s.kind)).toEqual(["text", "code", "text", "md", "text"]);
    expect(out[1]).toMatchObject({ code: "print(1)", language: "python" });
    expect(out[3]).toMatchObject({ markdown: "# 标题", code: "" });
  });

  it("buildPrompt: direction narrows the instruction", () => {
    expect(buildPrompt("T", "{}", "锚", [], "children")).toContain("只给出 children 建议");
    expect(buildPrompt("T", "{}", "锚", ["A", "B"], "both")).toContain("A、B");
  });
});

describe("BoardCompletionService", () => {
  it("读板经 MCP（uid 走调用参数）+ 结构化建议归一化", async () => {
    const calls: Captured[] = [];
    const client = fakeClient(JSON.parse(boardDoc(anchorTree)), calls);
    const service = makeService(client, {
      children: [{ text: "子节点", reason: "依据", kind: "text" }],
      siblings: [{ text: "同级", reason: "", kind: "code", code: "print(1)", language: "python" }],
    });

    const res = await service.complete(7, { board_uuid: "b-1", anchor_uid: "a-1" });
    expect(res.anchor_text).toBe("锚点节点");
    expect(res.children).toEqual([
      { text: "子节点", reason: "依据", kind: "text", code: "", language: "", markdown: "" },
    ]);
    expect(res.siblings[0]).toMatchObject({ kind: "code", code: "print(1)", language: "python" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tool: "get_board", args: { board_uuid: "b-1" }, uid: 7 });
  });

  it("direction=children 丢弃模型返回的 siblings", async () => {
    const client = fakeClient(JSON.parse(boardDoc(anchorTree)));
    const service = makeService(client, {
      children: [{ text: "子", reason: "", kind: "text" }],
      siblings: [{ text: "同", reason: "", kind: "text" }],
    });
    const res = await service.complete(1, { board_uuid: "b-1", anchor_uid: "a-1", direction: "children" });
    expect(res.children).toHaveLength(1);
    expect(res.siblings).toHaveLength(0);
  });

  it("空板（无 root）直接返回空建议，不调用模型", async () => {
    const client = fakeClient({ uuid: "b-1", content: "{}" });
    const generateCalls: unknown[] = [];
    const service = makeService(client, { children: [], siblings: [] }, generateCalls);
    const res = await service.complete(2, { board_uuid: "b-1" });
    expect(res).toEqual({ anchor_text: "", children: [], siblings: [] });
    expect(generateCalls).toHaveLength(0);
  });

  it("锚点缺失 → 404", async () => {
    const client = fakeClient(JSON.parse(boardDoc(anchorTree)));
    const service = makeService(client, { children: [], siblings: [] });
    await expect(service.complete(3, { board_uuid: "b-1", anchor_uid: "nope" })).rejects.toMatchObject({
      name: "BoardCompletionError",
      status: 404,
    });
  });

  it("MCP 传输失败 → 502", async () => {
    const client = fakeClient({}, [], true);
    const service = makeService(client, { children: [], siblings: [] });
    const err = await service.complete(4, { board_uuid: "b-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardCompletionError);
    expect((err as BoardCompletionError).status).toBe(502);
  });

  it("每 uid 滑动窗口限流 → 第 21 次 429", async () => {
    const client = fakeClient(JSON.parse(boardDoc(anchorTree)));
    const service = makeService(client, { children: [], siblings: [] });
    for (let i = 0; i < 20; i += 1) {
      await service.complete(5, { board_uuid: "b-1", anchor_uid: "a-1" });
    }
    await expect(service.complete(5, { board_uuid: "b-1", anchor_uid: "a-1" })).rejects.toMatchObject({ status: 429 });
    // 其他 uid 不受影响
    await expect(service.complete(6, { board_uuid: "b-1", anchor_uid: "a-1" })).resolves.toBeDefined();
  });
});
