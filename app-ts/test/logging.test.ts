import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import {
  buildLogDestination,
  buildPinoOptions,
  MAX_URL_CHARS,
  REDACT_PATHS,
  REDACTED,
  sanitizeUrl,
} from "../src/logger.js";
import { runWithRequestContext } from "../src/context/request-context.js";

/** Collect pino JSON lines from an in-memory Writable. */
function captureSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(line);
      }
      callback();
    },
  });
  return { lines, stream };
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("sanitizeUrl", () => {
  it("masks sensitive query values and keeps benign ones", () => {
    const url =
      "/chat/ask/stream?token=abc&x=1&ACCESS_TOKEN=xyz&api_key=k&apikey=ak&sig=s&signature=z&code=c&password=p&secret=sec&session=sess&ticket=t&foo=bar";
    const safe = sanitizeUrl(url);
    expect(safe).toContain("token=[REDACTED]");
    expect(safe).toContain("ACCESS_TOKEN=[REDACTED]");
    expect(safe).toContain("api_key=[REDACTED]");
    expect(safe).toContain("apikey=[REDACTED]");
    expect(safe).toContain("sig=[REDACTED]");
    expect(safe).toContain("signature=[REDACTED]");
    expect(safe).toContain("code=[REDACTED]");
    expect(safe).toContain("password=[REDACTED]");
    expect(safe).toContain("secret=[REDACTED]");
    expect(safe).toContain("session=[REDACTED]");
    expect(safe).toContain("ticket=[REDACTED]");
    expect(safe).toContain("x=1");
    expect(safe).toContain("foo=bar");
    expect(safe).not.toContain("abc");
    expect(safe).not.toContain("xyz");
  });

  it("masks path-carried share tokens", () => {
    expect(sanitizeUrl("/notes/shared/AbC123token")).toBe("/notes/shared/[REDACTED]");
    expect(sanitizeUrl("/cloud/s/AbC123token?x=1")).toBe("/cloud/s/[REDACTED]?x=1");
    expect(sanitizeUrl("/notes/shared/AbC/extra")).toBe("/notes/shared/[REDACTED]/extra");
  });

  it("drops the whole query of MinIO pre-signed proxy URLs", () => {
    const safe = sanitizeUrl(
      "/minio-proxy/drive/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=cred&X-Amz-Signature=deadbeef",
    );
    expect(safe).toBe(`/minio-proxy/drive/a.png?${REDACTED}`);
    expect(safe).not.toContain("deadbeef");
    expect(safe).not.toContain("X-Amz-Credential");
    expect(sanitizeUrl("/minio-proxy/drive/a.png")).toBe("/minio-proxy/drive/a.png");
  });

  it("caps the sanitized URL length", () => {
    const safe = sanitizeUrl(`/x?q=${"a".repeat(4000)}`);
    expect(safe.length).toBe(MAX_URL_CHARS);
    expect(MAX_URL_CHARS).toBe(512);
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("buildPinoOptions", () => {
  it("sets ISO time, base fields, err serializer and redaction", () => {
    const options = buildPinoOptions({ level: "debug", service: "unit-svc", env: "test" });
    expect(options.level).toBe("debug");
    expect(typeof options.timestamp).toBe("function");
    expect(options.base).toMatchObject({ service: "unit-svc", env: "test", pid: process.pid });
    expect(typeof (options.base as { hostname?: unknown }).hostname).toBe("string");
    expect(options.serializers?.err).toBe(pino.stdSerializers.err);

    const redact = options.redact as { paths: string[]; censor: string };
    expect(redact.censor).toBe(REDACTED);
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["set-cookie"]',
      "*.authorization",
      "*.apiKey",
      "*.api_key",
      "*.apikey",
      "*.password",
      "*.secret",
      "*.token",
      "*.accessKey",
      "*.secretKey",
      "*.privateKey",
      "*.credential",
    ]) {
      expect(redact.paths).toContain(path);
    }
    expect(REDACT_PATHS).toBe(redact.paths);
  });

  it("mixin injects request_id/uid only inside a request context", () => {
    const options = buildPinoOptions({ service: "unit-svc", env: "test" });
    const mixin = options.mixin as (context: object) => Record<string, unknown>;
    expect(mixin({})).toEqual({});
    runWithRequestContext({ requestId: "req-mixin", uid: "42", startedAt: 0 }, () => {
      expect(mixin({})).toEqual({ request_id: "req-mixin", uid: "42" });
    });
  });
});

describe("logger records", () => {
  it("emits service/module/request_id/uid and censors credentials", async () => {
    const { lines, stream } = captureSink();
    const logger = pino(buildPinoOptions({ level: "info", service: "unit-test", env: "test" }), stream).child({
      module: "TESTMOD",
    });

    await runWithRequestContext({ requestId: "req-42", uid: "1024", startedAt: Date.now() }, async () => {
      logger.info(
        { user: { password: "hunter2", token: "tok-nested" }, token: "tok-flat", note: "ok" },
        "[TESTMOD] hello",
      );
    });
    await until(() => lines.length >= 1);

    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]!) as Record<string, any>;
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(record.level).toBe(30);
    expect(record.service).toBe("unit-test");
    expect(record.env).toBe("test");
    expect(record.module).toBe("TESTMOD");
    expect(record.msg).toBe("[TESTMOD] hello");
    expect(record.request_id).toBe("req-42");
    expect(record.uid).toBe("1024");
    expect(record.user.password).toBe(REDACTED);
    expect(record.user.token).toBe(REDACTED);
    expect(record.token).toBe(REDACTED);
    expect(record.note).toBe("ok");
  });

  it("serializes err as a structured object", async () => {
    const { lines, stream } = captureSink();
    const logger = pino(buildPinoOptions({ level: "info", service: "unit-test", env: "test" }), stream);
    logger.error({ err: new Error("boom") }, "[TESTMOD] failed");
    await until(() => lines.length >= 1);
    const record = JSON.parse(lines[0]!) as Record<string, any>;
    expect(record.err.type).toBe("Error");
    expect(record.err.message).toBe("boom");
    expect(typeof record.err.stack).toBe("string");
  });
});

describe("rotating file sink", () => {
  it("rotates to gzip files, keeps retention and compresses readable content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-log-rot-"));
    const stream = createStream("app-ts.log", {
      path: dir,
      size: "1K",
      maxFiles: 2,
      compress: "gzip",
      history: "app-ts.log.history",
      immutable: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        let written = 0;
        const writeNext = () => {
          if (written >= 80) {
            stream.end(() => resolve());
            return;
          }
          written += 1;
          stream.write(`${"x".repeat(200)}\n`, (err) => {
            if (err) reject(err);
            else writeNext();
          });
        };
        writeNext();
      });

      await until(() => readdirSync(dir).some((file) => file.endsWith(".gz")), 3000);
      const gzFiles = readdirSync(dir).filter((file) => file.endsWith(".gz"));
      expect(gzFiles.length).toBeGreaterThan(0);

      const content = gunzipSync(readFileSync(join(dir, gzFiles[0]!))).toString();
      expect(content.length).toBeGreaterThan(0);

      // maxFiles caps the number of retained rotated files.
      expect(readdirSync(dir).filter((file) => file.endsWith(".gz")).length).toBeLessThanOrEqual(2);
    } finally {
      stream.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildLogDestination falls back to a plain file when rotation is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-log-plain-"));
    const dest = buildLogDestination({
      dir,
      fileName: "plain.log",
      rotation: { enabled: false, size: "20M", interval: "1d", maxFiles: 14, compress: "gzip" },
    });
    const file = join(dir, "plain.log");
    try {
      dest.write(JSON.stringify({ msg: "plain-line" }) + "\n");
      // SonicBoom flushes asynchronously; end() then poll for the flushed line.
      (dest as unknown as { end: () => void }).end();
      await until(() => existsSync(file) && readFileSync(file, "utf-8").includes("plain-line"));
      expect(readFileSync(file, "utf-8")).toContain("plain-line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
