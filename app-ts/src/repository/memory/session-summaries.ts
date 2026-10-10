import { randomUUID } from "node:crypto";

import type {
  SessionSummaryDoc,
  SessionSummaryInsert,
  SessionSummaryRepository,
} from "../session-summaries.js";

/** In-memory fallback (Mongo unavailable) — mirrors the other memory stores. */
export class MemorySessionSummaryStore implements SessionSummaryRepository {
  private readonly docs: SessionSummaryDoc[] = [];

  async insert(input: SessionSummaryInsert): Promise<SessionSummaryDoc> {
    const doc: SessionSummaryDoc = { summaryId: randomUUID(), createdAt: Date.now(), ...input };
    this.docs.push(doc);
    return doc;
  }

  async latest(chatSessionId: string, uid: string): Promise<SessionSummaryDoc | undefined> {
    return this.docs
      .filter((d) => d.chatSessionId === chatSessionId && d.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }
}
