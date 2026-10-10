import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../src/agent/circuit.js";

describe("CircuitBreaker", () => {
  it("初始为 closed 且不熔断", () => {
    const b = new CircuitBreaker(3, 100);
    expect(b.state).toBe("closed");
    expect(b.isTripped).toBe(false);
  });

  it("连续失败达到阈值后 open", () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure();
    b.recordFailure();
    expect(b.isTripped).toBe(false);
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.isTripped).toBe(true);
  });

  it("成功重置计数", () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.isTripped).toBe(false);
  });

  it("冷却后进入 half_open", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(1, 100);
    b.recordFailure();
    expect(b.isTripped).toBe(true);
    vi.advanceTimersByTime(150);
    expect(b.isTripped).toBe(false);
    expect(b.state).toBe("half_open");
    vi.useRealTimers();
  });

  it("half_open 失败重回 open", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(1, 100);
    b.recordFailure();
    vi.advanceTimersByTime(150);
    expect(b.isTripped).toBe(false); // half_open
    b.recordFailure();
    expect(b.state).toBe("open");
    vi.useRealTimers();
  });
});
