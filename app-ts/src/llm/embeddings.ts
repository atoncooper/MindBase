import { config } from "../config/index.js";

/**
 * Embedding client: direct HTTP calls to the Higress gateway OpenAI-compatible /v1/embeddings.
 * Mirrors the call style of the Go side app-cloud/internal/pipeline/embed.go.
 */
export interface EmbeddingsClient {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** Startup dimension probe: for red-line validation */
  probeDimension(): Promise<number>;
}

export class GatewayEmbeddings implements EmbeddingsClient {
  constructor(
    private readonly model: string = config.embedding.model,
    private readonly batchSize: number = config.embedding.batchSize,
    private readonly timeoutMs: number = 60_000,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.request(batch)));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.request([text]);
    return vec;
  }

  async probeDimension(): Promise<number> {
    const vec = await this.embedQuery("dim-probe");
    return vec.length;
  }

  private async request(input: string[]): Promise<number[][]> {
    const res = await fetch(`${config.aiGateway.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiGateway.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`[EMBEDDING] gateway ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const data = json.data;
    if (!data || data.length !== input.length) {
      throw new Error(`[EMBEDDING] unexpected response shape: got ${data?.length ?? 0}, want ${input.length}`);
    }
    return data.map((d) => d.embedding);
  }
}
