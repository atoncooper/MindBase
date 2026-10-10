import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFiles } from "../src/config/loader.js";

let dir: string;

function setup(files: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfigFiles", () => {
  it("default.yaml is required", () => {
    dir = mkdtempSync(join(tmpdir(), "cfg-"));
    expect(() => loadConfigFiles(dir)).toThrow(/no config files found/);
  });

  it("layered merge: local.yaml overrides default.yaml per leaf", () => {
    setup({
      "default.yaml": "server:\n  host: 127.0.0.1\n  port: 8008\nllm:\n  model: a\n",
      "config.yaml": "llm:\n  model: b\n",
      "local.yaml": "server:\n  port: 9999\n",
    });
    const { value, sources } = loadConfigFiles(dir);
    expect(sources).toHaveLength(3);
    expect((value.server as Record<string, unknown>).host).toBe("127.0.0.1");
    expect((value.server as Record<string, unknown>).port).toBe(9999); // local wins
    expect((value.llm as Record<string, unknown>).model).toBe("b"); // config.yaml beats default
  });

  it("${VAR} / ${VAR:default} placeholders expand from env", () => {
    setup({ "default.yaml": 'ai:\n  key: ${AI_KEY}\n  url: ${AI_URL:http://fallback}\n' });
    vi.stubEnv("AI_KEY", "sk-secret");
    delete process.env.AI_URL;
    const { value } = loadConfigFiles(dir);
    const ai = value.ai as Record<string, unknown>;
    expect(ai.key).toBe("sk-secret");
    expect(ai.url).toBe("http://fallback");
  });

  it("env overrides use SECTION__KEY (camelCase→SNAKE) with type coercion", () => {
    setup({
      "default.yaml":
        "server:\n  port: 8008\nlog:\n  fileEnabled: true\nllm:\n  temperature: 0.7\n",
    });
    vi.stubEnv("SERVER__PORT", "9001");
    vi.stubEnv("LOG__FILE_ENABLED", "false");
    vi.stubEnv("LLM__TEMPERATURE", "0.2");
    const { value } = loadConfigFiles(dir);
    expect((value.server as Record<string, unknown>).port).toBe(9001);
    expect((value.log as Record<string, unknown>).fileEnabled).toBe(false);
    expect((value.llm as Record<string, unknown>).temperature).toBe(0.2);
  });

  it("non-numeric env for a number leaf keeps the string (visible in logs, not silently typed)", () => {
    setup({ "default.yaml": "server:\n  port: 8008\n" });
    vi.stubEnv("SERVER__PORT", "abc");
    const { value } = loadConfigFiles(dir);
    expect((value.server as Record<string, unknown>).port).toBe("abc");
  });
});

// ensure the real repo default.yaml is complete enough to type-check against AppConfig
describe("real config/default.yaml", () => {
  it("loads and contains every section consumed by the code", async () => {
    const { value } = loadConfigFiles();
    for (const section of [
      "server", "aiGateway", "llm", "embedding", "rerank", "milvus", "mongo",
      "boardMcp", "search", "agent", "chunk", "log", "rateLimit", "prompts",
      "context", "timezone", "openrouter", "ocr",
    ]) {
      expect(value[section], `missing section: ${section}`).toBeTruthy();
    }
  });
});
