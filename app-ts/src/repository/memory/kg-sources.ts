import type { AsrTranscript, KgSourceStore } from "../kg-sources.js";

/** Memory fallback: no sources — the build fails per-page with the same
 * "no ASR content" error the Python pipeline raises on a missing doc. */
export class MemoryKgSourceStore implements KgSourceStore {
  private readonly docs = new Map<string, AsrTranscript>();

  seed(bvid: string, cid: number, transcript: AsrTranscript): void {
    this.docs.set(`${bvid}|${cid}`, transcript);
  }

  async getLatest(bvid: string, cid: number): Promise<AsrTranscript | undefined> {
    return this.docs.get(`${bvid}|${cid}`);
  }

  async close(): Promise<void> {}
}
