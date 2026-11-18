import { createLogger } from "../../logger.js";

const log = createLogger("SANDBOX");

/** 项目级沙箱租约释放器：app-ts purge 前调用 app-sandbox，避免已删项目继续占用 lease/workspace。 */
export interface SandboxLeaseReleaserOptions {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SandboxLeaseReleaser {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SandboxLeaseReleaserOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Best effort: never throws; returns the number of released leases (0 on failure). */
  async releaseProject(uid: string, projectId: string): Promise<number> {
    if (!this.options.enabled || !this.baseUrl || !this.apiKey) return 0;
    const url =
      this.baseUrl +
      "/v1/leases?uid=" +
      encodeURIComponent(uid) +
      "&projectId=" +
      encodeURIComponent(projectId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          apikey: this.apiKey,
          "X-API-Key": this.apiKey,
          "X-Uid": uid,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn("[SANDBOX] release project leases failed status=" + res.status + " project=" + projectId);
        return 0;
      }
      const body = (await res.json()) as { released?: unknown };
      const released = typeof body.released === "number" ? body.released : 0;
      if (released > 0) log.info("[SANDBOX] released project leases count=" + released + " project=" + projectId);
      return released;
    } catch (err) {
      log.warn(
        "[SANDBOX] release project leases error project=" + projectId + ": " + (err instanceof Error ? err.message : err),
      );
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }
}
