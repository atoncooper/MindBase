import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { MongoChatStore } from "../src/repository/mongo/chat-store.js";

/**
 * Mongo store closed-loop test: runs real assertions when a local MongoDB is listening on 27017 (docker compose),
 * otherwise the whole group is skipped. Uses a dedicated test database mind_base_ts_test; does not pollute mind_base_ts.
 */

process.env.MONGO__URI ||= "mongodb://127.0.0.1:27017";
process.env.MONGO__DB ||= "mind_base_ts_test";

let store: MongoChatStore | null = null;

beforeAll(async () => {
  const { MongoChatStore: Cls } = await import("../src/repository/mongo/chat-store.js");
  store = await Cls.connect();
}, 15_000);

afterAll(async () => {
  await store?.close();
});

describe("MongoChatStore", () => {
  it("连接（不可用则 skip 整组前提）", (ctx) => {
    if (!store) return ctx.skip();
    expect(store).toBeInstanceOf(Object);
  });

  it("getOrCreate 幂等且记录 uid", async (ctx) => {
    if (!store) return ctx.skip();
    const id = `s-${randomUUID()}`;
    const first = await store.getOrCreate(id, 42);
    const second = await store.getOrCreate(id, 42);
    expect(second.id).toBe(first.id);
    expect(first.uid).toBe(42);
    // touch updates updatedAt
    const before = first.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(id);
    const listed = await store.list(42);
    expect(listed[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("beginTurn → appendChunk → finalizeTurn 闭环", async (ctx) => {
    if (!store) return ctx.skip();
    const sessionId = `s-${randomUUID()}`;
    await store.getOrCreate(sessionId, 1);
    const { userMsg, assistantMsg } = await store.beginTurn(sessionId, "什么是闭包？");
    expect(userMsg.role).toBe("user");
    expect(assistantMsg.status).toBe("pending");

    await store.appendChunk(assistantMsg.id, "闭包是");
    await store.appendChunk(assistantMsg.id, "函数与其");
    await store.appendChunk(assistantMsg.id, "词法环境的组合。");
    await store.finalizeTurn(assistantMsg.id, {
      sources: [{ chunkId: "c1", bvid: "BV1" }],
      status: "done",
    });

    const final = await store.getMessage(assistantMsg.id);
    expect(final?.content).toBe("闭包是函数与其词法环境的组合。");
    expect(final?.status).toBe("done");
    expect(final?.sources).toEqual([{ chunkId: "c1", bvid: "BV1" }]);
    expect(final?.chunks).toBeUndefined(); // Chunks already cleared
  });

  it("recentMessages 按时间正序且只含 done 消息", async (ctx) => {
    if (!store) return ctx.skip();
    const sessionId = `s-${randomUUID()}`;
    await store.getOrCreate(sessionId, 1);
    await store.beginTurn(sessionId, "第一问");
    const t2 = await store.beginTurn(sessionId, "第二问");
    // The second turn's assistant message stays pending
    await store.appendChunk(t2.assistantMsg.id, "写一半");
    const recent = await store.recentMessages(sessionId, 10);
    expect(recent.map((m) => m.content)).toEqual(["第一问"]);
  });

  it("list 按 uid 隔离", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = Math.floor(Math.random() * 1e9);
    await store.getOrCreate(`s-${randomUUID()}`, uid);
    const listed = await store.list(uid);
    expect(listed).toHaveLength(1);
    expect(listed.every((s) => s.uid === uid)).toBe(true);
  });
});
