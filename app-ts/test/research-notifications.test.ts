import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import {
  ACADEMIC_NOTIFICATION_DEFAULT_LIMIT,
  ACADEMIC_NOTIFICATION_MAX_LIMIT,
  academicNotificationListLimit,
  isAcademicNotificationType,
  type AcademicNotification,
  type AcademicNotificationRepository,
} from "../src/repository/academic-notifications.js";
import { MemoryAcademicNotificationRepository } from "../src/repository/memory/academic-notifications.js";
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  ResearchNotificationService,
  type ResearchNotificationCreateInput,
} from "../src/services/research/notifications.js";
import { registerNotificationRoutes } from "../src/transport/http/routes/notifications.js";

/**
 * Notification centre : contract helpers, the memory store, the
 * best-effort service and the REST surface. Everything runs offline over the
 * memory repository — no Mongo, no network.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let rowSeq = 0;

function row(overrides: Partial<AcademicNotification> = {}): AcademicNotification {
  rowSeq += 1;
  return {
    id: overrides.id ?? "n" + rowSeq,
    uid: overrides.uid ?? "u1",
    projectId: overrides.projectId ?? "p1",
    type: overrides.type ?? "approval",
    title: overrides.title ?? "通知 " + rowSeq,
    createdAt: overrides.createdAt ?? 1000 + rowSeq,
    ...(overrides.body !== undefined ? { body: overrides.body } : {}),
    ...(overrides.link !== undefined ? { link: overrides.link } : {}),
    ...(overrides.readAt !== undefined ? { readAt: overrides.readAt } : {}),
  };
}

async function seed(
  repo: MemoryAcademicNotificationRepository,
  overrides: Partial<AcademicNotification> = {},
): Promise<AcademicNotification> {
  const notification = row(overrides);
  await repo.create(notification);
  return notification;
}

/** Shared create input for the service/route cases (overridden per test). */
const baseCreate = (overrides: Partial<ResearchNotificationCreateInput> = {}): ResearchNotificationCreateInput => ({
  uid: "u1",
  projectId: "p1",
  type: "approval",
  title: "待审批：实验 A",
  ...overrides,
});

/** Store double whose writes always fail (best-effort behaviour). */
class FailingNotificationRepository implements AcademicNotificationRepository {
  async create(): Promise<void> {
    throw new Error("notification store down");
  }
  async listByUid(): Promise<AcademicNotification[]> {
    return [];
  }
  async unreadCount(): Promise<number> {
    return 0;
  }
  async markRead(): Promise<boolean> {
    return false;
  }
  async removeByProject(): Promise<number> {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Contract helpers
// ---------------------------------------------------------------------------

describe("academic notification contract helpers", () => {
 it("normalizes list limits to default 20 / [1, 100]", () => {
    expect(ACADEMIC_NOTIFICATION_DEFAULT_LIMIT).toBe(20);
    expect(ACADEMIC_NOTIFICATION_MAX_LIMIT).toBe(100);
    expect(academicNotificationListLimit()).toBe(20);
    expect(academicNotificationListLimit(Number.NaN)).toBe(20);
    expect(academicNotificationListLimit(5)).toBe(5);
    expect(academicNotificationListLimit(0)).toBe(1);
    expect(academicNotificationListLimit(-3)).toBe(1);
    expect(academicNotificationListLimit(101)).toBe(100);
    expect(academicNotificationListLimit(2.9)).toBe(2);
  });

 it("guards notification types", () => {
    for (const type of ["approval", "experiment", "validation", "plan", "system"]) {
      expect(isAcademicNotificationType(type)).toBe(true);
    }
    expect(isAcademicNotificationType("bogus")).toBe(false);
    expect(isAcademicNotificationType(1)).toBe(false);
    expect(isAcademicNotificationType(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

describe("ResearchNotificationService", () => {
 it("creates one notification with a generated id and trims/keeps optional fields", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);
    const before = Date.now();

    const created = await service.create(
      baseCreate({
        title: "  实验 A 已批准  ",
        body: "  可以提交了  ",
        link: " /research?project=p1&tab=approval ",
      }),
    );

    expect(created).toBeDefined();
    expect(created!.id).toMatch(/[0-9a-f-]{36}/);
    expect(created!.uid).toBe("u1");
    expect(created!.projectId).toBe("p1");
    expect(created!.type).toBe("approval");
    expect(created!.title).toBe("实验 A 已批准");
    expect(created!.body).toBe("可以提交了");
    expect(created!.link).toBe("/research?project=p1&tab=approval");
    expect(created!.readAt).toBeUndefined();
    expect(created!.createdAt).toBeGreaterThanOrEqual(before);
    expect(created!.createdAt).toBeLessThanOrEqual(Date.now());

    const listed = await service.list("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created!.id);
    expect(listed[0]!.body).toBe("可以提交了");
  });

 it("clips the title to 200 and the body to 1000 characters and honours createdAt", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);

    const created = await service.create(
      baseCreate({
        type: "experiment",
        title: "题".repeat(NOTIFICATION_TITLE_MAX + 25),
        body: "字".repeat(NOTIFICATION_BODY_MAX + 25),
        createdAt: 123456,
      }),
    );

    expect(created).toBeDefined();
    expect(created!.title).toHaveLength(NOTIFICATION_TITLE_MAX);
    expect(created!.body).toHaveLength(NOTIFICATION_BODY_MAX);
    expect(created!.createdAt).toBe(123456);

    // Exactly-at-limit values are preserved unchanged.
    const atLimit = await service.create(
      baseCreate({ title: "短标题", body: "x".repeat(NOTIFICATION_BODY_MAX), createdAt: 1 }),
    );
    expect(atLimit!.title).toBe("短标题");
    expect(atLimit!.body).toHaveLength(NOTIFICATION_BODY_MAX);
  });

 it("skips unusable input instead of throwing", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);

    expect(await service.create(baseCreate({ title: "   " }))).toBeUndefined();
    expect(await service.create(baseCreate({ uid: "" }))).toBeUndefined();
    expect(await service.create(baseCreate({ projectId: " " }))).toBeUndefined();
    expect(await service.create(baseCreate({ type: "bogus" as never }))).toBeUndefined();
    expect(await service.create(undefined as unknown as ResearchNotificationCreateInput)).toBeUndefined();
    expect(await service.list("u1")).toEqual([]);
  });

 it("is best-effort when the store fails", async () => {
    const service = new ResearchNotificationService(new FailingNotificationRepository());
    await expect(service.create(baseCreate())).resolves.toBeUndefined();
    // Read paths still answer their neutral values rather than throwing.
    await expect(service.list("u1")).resolves.toEqual([]);
    await expect(service.unreadCount("u1")).resolves.toBe(0);
    await expect(service.markRead("u1", "n1")).resolves.toBe(false);
  });

 it("lists newest-first, uid-scoped and limited", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);
    const old = await seed(repo, { id: "old", uid: "u1", createdAt: 100 });
    const mid = await seed(repo, { id: "mid", uid: "u1", createdAt: 200 });
    const newest = await seed(repo, { id: "new", uid: "u1", createdAt: 300 });
    await seed(repo, { id: "foreign", uid: "u2", createdAt: 400 });

    expect((await service.list("u1")).map((n) => n.id)).toEqual([newest.id, mid.id, old.id]);
    expect((await service.list("u2")).map((n) => n.id)).toEqual(["foreign"]);
    expect(await service.list("nobody")).toEqual([]);

    expect((await service.list("u1", { limit: 2 })).map((n) => n.id)).toEqual([newest.id, mid.id]);
    // Out-of-range limits clamp: 0 → 1 row, 1000 → at most the max page.
    expect((await service.list("u1", { limit: 0 })).map((n) => n.id)).toEqual([newest.id]);
    expect(await service.list("u1", { limit: 1000 })).toHaveLength(3);

    // Default page size is 20 even when more rows exist.
    for (let i = 0; i < 25; i += 1) {
      await seed(repo, { uid: "u3", createdAt: 1000 + i });
    }
    const page = await service.list("u3");
    expect(page).toHaveLength(ACADEMIC_NOTIFICATION_DEFAULT_LIMIT);
    expect(page[0]!.createdAt).toBe(1024);

    // Hard cap is 100.
    for (let i = 0; i < 105; i += 1) {
      await seed(repo, { uid: "u4", createdAt: 2000 + i });
    }
    expect(await service.list("u4", { limit: 1000 })).toHaveLength(ACADEMIC_NOTIFICATION_MAX_LIMIT);
  });

 it("counts unread rows and filters unread-only lists", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);
    const unreadA = await seed(repo, { id: "a", uid: "u1", createdAt: 100 });
    const unreadB = await seed(repo, { id: "b", uid: "u1", createdAt: 200 });
    const readC = await seed(repo, { id: "c", uid: "u1", createdAt: 300, readAt: 400 });
    await seed(repo, { id: "foreign", uid: "u2", createdAt: 500 });

    expect(await service.unreadCount("u1")).toBe(2);
    expect(await service.unreadCount("u2")).toBe(1);
    expect(await service.unreadCount("nobody")).toBe(0);

    const unreadOnly = await service.list("u1", { unreadOnly: true });
    expect(unreadOnly.map((n) => n.id)).toEqual([unreadB.id, unreadA.id]);
    expect(unreadOnly.every((n) => n.readAt === undefined)).toBe(true);
    expect(await service.list("u1")).toHaveLength(3);

    await service.markRead("u1", unreadA.id);
    expect(await service.unreadCount("u1")).toBe(1);
    expect((await service.list("u1", { unreadOnly: true })).map((n) => n.id)).toEqual([unreadB.id]);

    // Copies are returned: mutating a listed row never mutates the store.
    const listed = await service.list("u1");
    listed.find((n) => n.id === unreadB.id)!.readAt = 42;
    expect(await service.unreadCount("u1")).toBe(1);
    expect(readC.readAt).toBe(400);
  });

 it("marks read once, idempotently, and never touches another user's row", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    const service = new ResearchNotificationService(repo);
    const own = await seed(repo, { id: "own-1", uid: "u1", createdAt: 100 });
    const ownSecond = await seed(repo, { id: "own-2", uid: "u1", createdAt: 200 });
    await seed(repo, { id: "foreign", uid: "u2", createdAt: 300 });

    expect(await service.markRead("u1", own.id)).toBe(true);
    const firstReadAt = (await repo.listByUid("u1")).find((n) => n.id === own.id)!.readAt;
    expect(firstReadAt).toBeTypeOf("number");

    // Idempotent: repeated calls answer true and keep the first read timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await service.markRead("u1", own.id)).toBe(true);
    const secondReadAt = (await repo.listByUid("u1")).find((n) => n.id === own.id)!.readAt;
    expect(secondReadAt).toBe(firstReadAt);

    // Foreign / missing / blank ids: false, nothing written.
    expect(await service.markRead("u1", "foreign")).toBe(false);
    expect(await service.markRead("u1", "missing")).toBe(false);
    expect(await service.markRead("", ownSecond.id)).toBe(false);
    expect(await service.markRead("u1", "")).toBe(false);
    expect(await repo.unreadCount("u2")).toBe(1);
    expect(await repo.unreadCount("u1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// REST surface
// ---------------------------------------------------------------------------

function buildApp() {
  const repo = new MemoryAcademicNotificationRepository();
  const service = new ResearchNotificationService(repo);
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerNotificationRoutes(app, { notifications: service });
  return { app, repo, service };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });
/** POST routes without a request body must not claim JSON content. */
const uidOnly = (uid: string) => ({ "x-uid": uid });

describe("notification routes", () => {
 it("requires the gateway uid", async () => {
    const { app } = buildApp();
    const list = await app.inject({ method: "GET", url: "/academic/notifications" });
    expect(list.statusCode).toBe(401);
    expect((list.json() as { detail: string }).detail).toContain("X-Uid");

    const read = await app.inject({ method: "POST", url: "/academic/notifications/whatever/read" });
    expect(read.statusCode).toBe(401);
    expect((read.json() as { detail: string }).detail).toContain("X-Uid");
    await app.close();
  });

 it("lists the caller's notifications newest-first with the badge count and unread filter", async () => {
    const { app, service } = buildApp();
    const old = (await service.create(baseCreate({ uid: "1", title: "旧通知", createdAt: 100 })))!;
    const mid = (await service.create(baseCreate({ uid: "1", title: "已读通知", createdAt: 200 })))!;
    const extra = (await service.create(
      baseCreate({ uid: "1", title: "其他项目通知", projectId: "p2", createdAt: 250 }),
    ))!;
    const newest = (await service.create(
      baseCreate({ uid: "1", title: "新通知", type: "experiment", createdAt: 300 }),
    ))!;
    await service.create(baseCreate({ uid: "999", title: "别人的通知", createdAt: 400 }));
    await service.markRead("1", mid.id);

    const res = await app.inject({
      method: "GET",
      url: "/academic/notifications",
      headers: asUid("1"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      notifications: Array<Record<string, unknown> & { id: string }>;
      unreadCount: number;
    };
    expect(body.unreadCount).toBe(3);
    expect(body.notifications.map((n) => n.id)).toEqual([newest.id, extra.id, mid.id, old.id]);
    // The payload never echoes uid / Mongo _id; optional link stays optional.
    expect(body.notifications[0]!.uid).toBeUndefined();
    expect(body.notifications[0]!._id).toBeUndefined();
    expect(body.notifications[0]!.type).toBe("experiment");
    expect(body.notifications[0]!.projectId).toBe("p1");
    expect(typeof body.notifications[0]!.createdAt).toBe("number");
    const readRow = body.notifications.find((n) => n.id === mid.id)!;
    expect(typeof readRow.readAt).toBe("number");
    const unreadRow = body.notifications.find((n) => n.id === old.id)!;
    expect(unreadRow.readAt).toBeUndefined();

    // limit caps the page but not the badge count.
    const one = await app.inject({
      method: "GET",
      url: "/academic/notifications?limit=1",
      headers: asUid("1"),
    });
    expect(one.statusCode).toBe(200);
    const oneBody = one.json() as { notifications: Array<{ id: string }>; unreadCount: number };
    expect(oneBody.notifications).toHaveLength(1);
    expect(oneBody.notifications[0]!.id).toBe(newest.id);
    expect(oneBody.unreadCount).toBe(3);

    // ?unread=1 hides the already-read row.
    const unread = await app.inject({
      method: "GET",
      url: "/academic/notifications?unread=1",
      headers: asUid("1"),
    });
    expect(unread.statusCode).toBe(200);
    const unreadBody = unread.json() as { notifications: Array<{ id: string }>; unreadCount: number };
    expect(unreadBody.notifications.map((n) => n.id)).not.toContain(mid.id);
    expect(unreadBody.notifications).toHaveLength(3);
    expect(unreadBody.unreadCount).toBe(3);

    // A malformed limit falls back to the default instead of failing.
    const malformed = await app.inject({
      method: "GET",
      url: "/academic/notifications?limit=abc",
      headers: asUid("1"),
    });
    expect(malformed.statusCode).toBe(200);
    expect((malformed.json() as { notifications: unknown[] }).notifications).toHaveLength(4);

    // Tenancy: another uid only sees its own rows.
    const foreign = await app.inject({
      method: "GET",
      url: "/academic/notifications",
      headers: asUid("999"),
    });
    expect(foreign.statusCode).toBe(200);
    const foreignBody = foreign.json() as { notifications: Array<{ id: string }>; unreadCount: number };
    expect(foreignBody.notifications).toHaveLength(1);
    expect(foreignBody.unreadCount).toBe(1);
    await app.close();
  });

 it("marks a notification read idempotently and 404s for foreign or missing rows", async () => {
    const { app, repo, service } = buildApp();
    const own = (await service.create(baseCreate({ uid: "1", title: "待读", createdAt: 100 })))!;
    const foreign = (await service.create(baseCreate({ uid: "999", title: "别人的", createdAt: 200 })))!;

    const first = await app.inject({
      method: "POST",
      url: "/academic/notifications/" + own.id + "/read",
      headers: uidOnly("1"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ read: true });
    const stored = (await repo.listByUid("1"))[0]!;
    expect(stored.readAt).toBeTypeOf("number");

    const second = await app.inject({
      method: "POST",
      url: "/academic/notifications/" + own.id + "/read",
      headers: uidOnly("1"),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ read: true });
    expect((await repo.listByUid("1"))[0]!.readAt).toBe(stored.readAt);

    // The unread filter now excludes the row and the badge drops.
    const listed = await app.inject({
      method: "GET",
      url: "/academic/notifications?unread=1",
      headers: asUid("1"),
    });
    expect(listed.json().notifications).toEqual([]);
    expect(listed.json().unreadCount).toBe(0);

    // Foreign row: 404 + detail, still unread for its owner.
    const foreignRead = await app.inject({
      method: "POST",
      url: "/academic/notifications/" + foreign.id + "/read",
      headers: uidOnly("1"),
    });
    expect(foreignRead.statusCode).toBe(404);
    expect((foreignRead.json() as { detail: string }).detail).toContain("不存在或无权访问");
    expect(await repo.unreadCount("999")).toBe(1);

    const missing = await app.inject({
      method: "POST",
      url: "/academic/notifications/does-not-exist/read",
      headers: uidOnly("1"),
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { detail: string }).detail).toContain("不存在或无权访问");
    await app.close();
  });
});
