/**
 * Per-agent persistent context (within a session): one independent context per (sessionId, agentName).
 * Entries are DISTILLED exchanges (task → final answer); tool-call noise never lands here
 * (write-side pollution control). The agent's run state may be done — its context persists.
 */
export interface AgentContextEntry {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface AgentContextSummary {
  summary: string;
  /** number of entries already covered by the rolling summary */
  summarizedCount: number;
  updatedAt: number;
}

export interface AgentContextRepository {
  append(sessionId: string, agentName: string, entry: AgentContextEntry): Promise<void>;
  recent(sessionId: string, agentName: string, limit: number): Promise<AgentContextEntry[]>;
  countEntries(sessionId: string, agentName: string): Promise<number>;
  listEntries(sessionId: string, agentName: string, skip: number, limit: number): Promise<AgentContextEntry[]>;
  getSummary(sessionId: string, agentName: string): Promise<AgentContextSummary | undefined>;
  saveSummary(sessionId: string, agentName: string, summary: AgentContextSummary): Promise<void>;
  /** keep only the last `keepLast` entries (compression prunes what it summarized) */
  trim(sessionId: string, agentName: string, keepLast: number): Promise<void>;
  /** drop context entries for a session (agentName omitted = all agents); returns deleted doc count */
  clear(sessionId: string, agentName?: string): Promise<number>;
}
