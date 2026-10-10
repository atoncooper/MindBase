import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request context: requestId / uid injected by HTTP middleware, propagated via AsyncLocalStorage
 * through agent → tools → LLM gateway headers (follows the repo's "per-request request-id" convention).
 * In-process background tasks (e.g. boot) have no request context and get undefined.
 */
export interface RequestContext {
  requestId: string;
  uid?: string;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(store: RequestContext, fn: () => T): T {
  return als.run(store, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export function newRequestId(): string {
  return randomUUID();
}
