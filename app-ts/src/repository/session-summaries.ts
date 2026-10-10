/**
 * Session summary persistence (port of app/repository/mongo_summary_repository.py).
 *
 * Summaries are produced by the session-summary endpoint (frontend button, not
 * chat routing) and stored SEPARATELY from chat messages — a summary must never
 * become part of the conversation it summarizes (it would pollute later
 * summaries and context compression). Re-generating appends a new document;
 * readers take the latest by createdAt.
 *
 * app-ts owns its own store (Mongo database mind_base_ts); Python's
 * mind_base.session_summaries is intentionally not read (old chat history is
 * not migrated — see docs/app-ts-cutover.md).
 */

export interface SessionSummaryDoc {
  summaryId: string;
  chatSessionId: string;
  uid: string;
  content: string;
  messageCount: number;
  /** epoch ms; the wire layer renders naive-UTC ISO like the rest of /chat */
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  createdAt: number;
}

export interface SessionSummaryInsert {
  chatSessionId: string;
  uid: string;
  content: string;
  messageCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
}

export interface SessionSummaryRepository {
  insert(input: SessionSummaryInsert): Promise<SessionSummaryDoc>;
  latest(chatSessionId: string, uid: string): Promise<SessionSummaryDoc | undefined>;
}
