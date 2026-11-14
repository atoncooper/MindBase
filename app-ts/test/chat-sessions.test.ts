import { describe, expect, it } from "vitest";
import { ChatSessionsService, ChatSessionsError } from "../src/services/chat-sessions.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import type { SessionDocumentMeta, SessionDocumentRepository } from "../src/repository/session-docs.js";

/** Test factory: zero grace so hidden-empty-session semantics are assertable without clock control. */
function makeService(opts: { emptyGraceMs?: number; sessionDocs?: SessionDocumentRepository } = {}) {
  const sessions = new MemoryChatSessionRepository();
  const messages = new MemoryMessageRepository();
  const svc = new ChatSessionsService(sessions, messages, {
    emptyGraceMs: opts.emptyGraceMs ?? 0,
    ...(opts.sessionDocs ? { sessionDocs: opts.sessionDocs } : {}),
  });
  return { svc, sessions, messages };
}

describe("chat sessions REST contract (Python /chat/sessions + /chat/history parity)", () => {
  it("creates a session with snake_case wire fields", async () => {
    const { svc } = makeService();
    const s = await svc.create(7, "我的会话");
    expect(s.chat_session_id).toBeTruthy();
    expect(s.title).toBe("我的会话");
    expect(s.status).toBe("active");
    expect(s.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.last_message_at).toBeNull();
  });

  it("creates a session bound to a research project and keeps the binding on list/get", async () => {
    // non-zero grace: the list hides/deletes empty sessions (a bound session is still empty)
    const { svc } = makeService({ emptyGraceMs: 60_000 });
    const created = await svc.create(7, "开题推进", "p-123");
    expect(created.academic_project_id).toBe("p-123");

    const fetched = await svc.get(7, created.chat_session_id);
    expect(fetched.academic_project_id).toBe("p-123");
    const list = await svc.list(7);
    expect(list.find((s) => s.chat_session_id === created.chat_session_id)?.academic_project_id).toBe("p-123");

    // no project chosen → 普通对话, explicitly null on the wire
    const plain = await svc.create(7);
    expect(plain.academic_project_id).toBeNull();
  });

  it("history paginates all messages (user+assistant) and maps done→completed", async () => {
    const { svc, sessions, messages } = makeService();
    const session = await sessions.getOrCreate("sess-1", 7);
    void session;
    await messages.beginTurn("sess-1", "第一问");
    await messages.beginTurn("sess-1", "第二问");
    await messages.beginTurn("sess-1", "第三问");

    const page1 = await svc.history(7, "sess-1", 1, 3);
    expect(page1.total).toBe(6);
    expect(page1.messages).toHaveLength(3);
    expect(page1.has_more).toBe(true);
    expect(page1.messages[0].role).toBe("user");
    expect(page1.messages[0].status).toBe("completed");

    const page3 = await svc.history(7, "sess-1", 2, 3);
    expect(page3.messages).toHaveLength(3);
    expect(page3.has_more).toBe(false);
  });

  it("treats another user's session as nonexistent (404, no existence leak)", async () => {
    const { svc, sessions } = makeService();
    await sessions.getOrCreate("sess-other", 200);
    await expect(svc.history(100, "sess-other", 1, 50)).rejects.toMatchObject({
      status: 404,
      message: "会话不存在",
    });
    await expect(svc.get(100, "sess-other")).rejects.toBeInstanceOf(ChatSessionsError);
  });

  it("renames only with a non-empty title (Python 400 parity)", async () => {
    const { svc, sessions } = makeService();
    await sessions.getOrCreate("sess-1", 7);
    await expect(svc.rename(7, "sess-1", "   ")).rejects.toMatchObject({ status: 400 });
    const renamed = await svc.rename(7, "sess-1", "新标题");
    expect(renamed.title).toBe("新标题");
  });

  it("truncates from the anchor inclusive (regenerate) and 404s on missing anchor", async () => {
    const { svc, sessions, messages } = makeService();
    await sessions.getOrCreate("sess-1", 7);
    const t1 = await messages.beginTurn("sess-1", "问1");
    await messages.beginTurn("sess-1", "问2");

    const res = await svc.truncateFrom(7, "sess-1", t1.userMsg.id);
    // anchor (user msg) inclusive: 问1user + 问1assistant + 问2user + 问2assistant
    expect(res).toEqual({ success: true, deleted: 4 });
    expect(await messages.countBySession("sess-1")).toBe(0);

    await expect(svc.truncateFrom(7, "sess-1", "no-such-msg")).rejects.toMatchObject({
      status: 404,
      message: "消息不存在",
    });
  });

  it("clearHistory deletes messages but keeps the session", async () => {
    const { svc, sessions, messages } = makeService();
    await sessions.getOrCreate("sess-1", 7);
    await messages.beginTurn("sess-1", "问1");
    await expect(svc.clearHistory(7, "sess-1")).resolves.toEqual({ success: true });
    expect(await messages.countBySession("sess-1")).toBe(0);
    expect(await sessions.get("sess-1", 7)).toBeTruthy();
  });

  it("delete removes the session and its messages", async () => {
    const { svc, sessions, messages } = makeService();
    await sessions.getOrCreate("sess-1", 7);
    await messages.beginTurn("sess-1", "问1");
    await expect(svc.delete(7, "sess-1")).resolves.toEqual({ success: true });
    expect(await sessions.get("sess-1", 7)).toBeUndefined();
    expect(await messages.countBySession("sess-1")).toBe(0);
  });

  it("keeps a session whose only content is uploaded documents", async () => {
    // A chat with an uploaded Word but no message yet is NOT an empty session.
    const saved = new Map<string, SessionDocumentMeta[]>();
    const sessionDocs: SessionDocumentRepository = {
      save: async (sessionId, filename, chunks, sizeBytes) => ({
        id: "d-" + sessionId,
        sessionId,
        filename,
        sizeBytes,
        chunkCount: chunks.length,
        createdAt: 1,
      }),
      list: async (sessionId) => saved.get(sessionId) ?? [],
      search: async () => [],
      delete: async () => false,
      deleteBySession: async () => 0,
    };
    const { svc, sessions } = makeService({ emptyGraceMs: 0, sessionDocs });
    await sessions.getOrCreate("sess-docs", 7);
    saved.set("sess-docs", [
      { id: "d1", sessionId: "sess-docs", filename: "开题报告.docx", sizeBytes: 10, chunkCount: 1, createdAt: 1 },
    ]);
    // Backdate so the empty-session sweep would fire if documents were ignored.
    const seedRepo = sessions as unknown as { sessions: Map<string, { createdAt: number }> };
    const doc = seedRepo.sessions.get("sess-docs");
    if (doc) doc.createdAt = Date.now() - 10 * 60 * 1000;

    const list = await svc.list(7);
    expect(list.some((s) => s.chat_session_id === "sess-docs")).toBe(true);
    expect(await sessions.get("sess-docs", 7)).toBeTruthy();
  });

  it("hides empty sessions past the grace window and self-cleans them", async () => {
    // 1s grace: a session created "just now" stays visible; a backdated one is hidden
    const { svc, sessions } = makeService({ emptyGraceMs: 1000 });
    const fresh = await svc.create(7, "刚刚创建");
    // an old empty session: seeded directly with a backdated createdAt
    const old = await sessions.getOrCreate("sess-old", 7);
    void old;
    // backdate by re-creating through the service is not possible — use the repo directly
    const seedRepo = sessions as unknown as {
      sessions: Map<string, { createdAt: number }>;
    };
    const doc = seedRepo.sessions.get("sess-old");
    if (doc) doc.createdAt = Date.now() - 10 * 60 * 1000;

    const list = await svc.list(7);
    expect(list.some((s) => s.chat_session_id === "sess-old")).toBe(false);
    expect(list.some((s) => s.chat_session_id === fresh.chat_session_id)).toBe(true);
    expect(await sessions.get("sess-old", 7)).toBeUndefined(); // self-cleaned
  });
});
