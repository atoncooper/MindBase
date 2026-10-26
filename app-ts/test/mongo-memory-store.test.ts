import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { MongoMemoryStore } from "../src/repository/mongo/memory-store.js";

/**
 * Mongo long-term-memory store closed-loop test: runs real assertions when a local
 * MongoDB is listening (docker compose), otherwise the whole group is skipped.
 * Uses the dedicated test database mind_base_ts_test; does not pollute mind_base_ts.
 * Every case gets a fresh uid so runs never see each other's rows.
 */

process.env.MONGO__URI ||= "mongodb://127.0.0.1:27017";
process.env.MONGO__DB ||= "mind_base_ts_test";

let store: MongoMemoryStore | null = null;

function newUid(): string {
  return `u-${randomUUID()}`;
}

beforeAll(async () => {
  const { MongoMemoryStore: Cls } = await import("../src/repository/mongo/memory-store.js");
  store = await Cls.connect();
}, 15_000);

afterAll(async () => {
  await store?.close();
});

describe("MongoMemoryStore", () => {
  it("连接（不可用则 skip 整组前提）", (ctx) => {
    if (!store) return ctx.skip();
    expect(store).toBeInstanceOf(Object);
  });

  it("add 落库后可被 list 读回（按 createdAt 倒序）", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = newUid();
    const first = await store.add(uid, "  用户偏好深色主题  ", ["偏好"]);
    expect(first.uid).toBe(uid);
    expect(first.content).toBe("用户偏好深色主题"); // trimmed like the memory implementation
    expect(first.tags).toEqual(["偏好"]);
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.add(uid, "用户在杭州工作");
    const listed = await store.list(uid);
    expect(listed.map((e) => e.content)).toEqual(["用户在杭州工作", "用户偏好深色主题"]);
    expect(listed[0].createdAt).toBeGreaterThanOrEqual(listed[1].createdAt);
    expect(listed[0].id).toBe(second.id);
  });

  it("list 返回该 uid 全部条目、显式 limit 生效", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = newUid();
    for (let i = 0; i < 5; i += 1) await store.add(uid, `记忆 ${i}`);
    expect(await store.list(uid)).toHaveLength(5);
    expect(await store.list(uid, 2)).toHaveLength(2);
  });

  it("search 关键词打分排序（完整命中 > 2-gram 命中）", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = newUid();
    await store.add(uid, "用户说主题很重要");
    await new Promise((r) => setTimeout(r, 5));
    await store.add(uid, "偏好深色主题");
    const hits = await store.search(uid, "深色主题");
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe("偏好深色主题"); // full-query hit scores above the 2-gram-only row
    expect(hits[1].content).toBe("用户说主题很重要");
  });

  it("search 默认 limit 5、按 uid 隔离且不命中时为空", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = newUid();
    const other = newUid();
    for (let i = 0; i < 8; i += 1) await store.add(uid, `喜欢咖啡的第 ${i} 条`);
    await store.add(other, "喜欢咖啡");
    const hits = await store.search(uid, "咖啡");
    expect(hits).toHaveLength(5);
    expect(hits.every((e) => e.uid === uid)).toBe(true);
    expect(await store.search(newUid(), "咖啡")).toEqual([]);
  });

  it("tags 参与检索", async (ctx) => {
    if (!store) return ctx.skip();
    const uid = newUid();
    await store.add(uid, "一条没有关键词的记忆", ["旅行"]);
    const hits = await store.search(uid, "旅行");
    expect(hits).toHaveLength(1);
  });
});
