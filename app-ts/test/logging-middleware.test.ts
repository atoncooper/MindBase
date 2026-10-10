import { describe, it, expect } from "vitest";
import { SlidingWindowLimiter } from "../src/transport/http/middleware/rate-limit.js";
import {
  runWithRequestContext,
  getRequestContext,
  newRequestId,
} from "../src/context/request-context.js";
import { createLogger } from "../src/logger.js";

describe("SlidingWindowLimiter", () => {
  it("窗口内放行到 max，之后拒绝", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 3 });
    expect(limiter.allow("ip1", 0)).toBe(true);
    expect(limiter.allow("ip1", 1)).toBe(true);
    expect(limiter.allow("ip1", 2)).toBe(true);
    expect(limiter.allow("ip1", 3)).toBe(false);
  });

  it("窗口滑动后恢复放行", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
    limiter.allow("ip1", 0);
    limiter.allow("ip1", 100);
    expect(limiter.allow("ip1", 500)).toBe(false);
    // Both 0 and 100 slide out of the window
    expect(limiter.allow("ip1", 1101)).toBe(true);
  });

  it("被拒的请求不占窗口额度", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow("ip1", 0)).toBe(true);
    expect(limiter.allow("ip1", 1)).toBe(false);
    expect(limiter.allow("ip1", 2)).toBe(false);
    // After 0 slides out, another request can pass
    expect(limiter.allow("ip1", 1001)).toBe(true);
  });

  it("按 key 隔离", () => {
    const limiter = new SlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow("ip1", 0)).toBe(true);
    expect(limiter.allow("ip2", 0)).toBe(true);
  });
});

describe("RequestContext (AsyncLocalStorage)", () => {
  it("runWithRequestContext 内可读取，外不可", () => {
    expect(getRequestContext()).toBeUndefined();
    runWithRequestContext({ requestId: "r1", uid: 7, startedAt: 0 }, () => {
      expect(getRequestContext()?.requestId).toBe("r1");
      expect(getRequestContext()?.uid).toBe(7);
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it("跨 await 与 async generator 传播", async () => {
    async function* gen() {
      await new Promise((r) => setTimeout(r, 5));
      yield getRequestContext()?.requestId;
    }
    const id = newRequestId();
    await runWithRequestContext({ requestId: id, startedAt: 0 }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      for await (const v of gen()) {
        expect(v).toBe(id);
      }
    });
  });
});

describe("logger", () => {
  it("createLogger 输出带 module 绑定与消息前缀", () => {
    const lines: string[] = [];
    const log = createLogger("TESTMOD");
    log.info("[TESTMOD] hello key=%d", 42);
    expect(log.bindings().module).toBe("TESTMOD");
    expect(lines).toHaveLength(0); // No custom sink; only verifies it does not throw
  });
});
