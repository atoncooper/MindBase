import type {
  AgentContextEntry,
  AgentContextRepository,
  AgentContextSummary,
} from "../agent-context.js";

interface ContextBucket {
  entries: AgentContextEntry[];
  summary?: AgentContextSummary;
}

/** In-memory implementation: isolation key = `${sessionId}:${agentName}`. */
export class MemoryAgentContextStore implements AgentContextRepository {
  private readonly buckets = new Map<string, ContextBucket>();

  private key(sessionId: string, agentName: string): string {
    return `${sessionId}:${agentName}`;
  }

  private bucket(sessionId: string, agentName: string): ContextBucket {
    const k = this.key(sessionId, agentName);
    let b = this.buckets.get(k);
    if (!b) {
      b = { entries: [] };
      this.buckets.set(k, b);
    }
    return b;
  }

  async append(sessionId: string, agentName: string, entry: AgentContextEntry): Promise<void> {
    this.bucket(sessionId, agentName).entries.push(entry);
  }

  private peek(sessionId: string, agentName: string): ContextBucket | undefined {
    return this.buckets.get(this.key(sessionId, agentName));
  }

  async recent(sessionId: string, agentName: string, limit: number): Promise<AgentContextEntry[]> {
    return (this.peek(sessionId, agentName)?.entries ?? []).slice(-limit);
  }

  async countEntries(sessionId: string, agentName: string): Promise<number> {
    return this.peek(sessionId, agentName)?.entries.length ?? 0;
  }

  async listEntries(sessionId: string, agentName: string, skip: number, limit: number): Promise<AgentContextEntry[]> {
    return (this.peek(sessionId, agentName)?.entries ?? []).slice(skip, skip + limit);
  }

  async getSummary(sessionId: string, agentName: string): Promise<AgentContextSummary | undefined> {
    return this.peek(sessionId, agentName)?.summary;
  }

  async saveSummary(sessionId: string, agentName: string, summary: AgentContextSummary): Promise<void> {
    this.bucket(sessionId, agentName).summary = summary;
  }

  async trim(sessionId: string, agentName: string, keepLast: number): Promise<void> {
    const b = this.bucket(sessionId, agentName);
    b.entries = b.entries.slice(-keepLast);
  }

  async clear(sessionId: string, agentName?: string): Promise<number> {
    let deleted = 0;
    for (const k of [...this.buckets.keys()]) {
      if (k.startsWith(`${sessionId}:`) && (agentName === undefined || k.endsWith(`:${agentName}`))) {
        this.buckets.delete(k);
        deleted += 1;
      }
    }
    return deleted;
  }
}
