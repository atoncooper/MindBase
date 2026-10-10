import { describe, it, expect } from "vitest";
import {
  QueueFullError,
  WeightedAdmissionQueue,
  type AdmissionQueueOptions,
} from "../src/services/admission.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const baseOpts = (over: Partial<AdmissionQueueOptions> = {}): AdmissionQueueOptions => ({
  maxConcurrent: 1,
  queueMaxSize: 5,
  tierWeights: { free: 0, vip: 100, svip: 200 },
  agingWindowMs: 30_000,
  agingStep: 10,
  ...over,
});

describe("WeightedAdmissionQueue", () => {
  it("grants immediately while slots are free, queues at the cap", () => {
    const q = new WeightedAdmissionQueue({ ...baseOpts(), maxConcurrent: 2 });
    const t1 = q.enqueue(1);
    const t2 = q.enqueue(2);
    expect(t1.acquired).toBe(true);
    expect(t2.acquired).toBe(true);

    const t3 = q.enqueue(3);
    expect(t3.acquired).toBe(false);
    expect(q.running).toBe(2);
    expect(q.waiting).toBe(1);
  });

  it("wakes waiters FIFO within the same tier", () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const t1 = q.enqueue(1);
    const t2 = q.enqueue(2);
    const t3 = q.enqueue(3);
    expect(t1.acquired).toBe(true);
    expect(t2.acquired).toBe(false);

    q.release(t1);
    expect(t2.acquired).toBe(true);
    expect(t3.acquired).toBe(false);

    q.release(t2);
    expect(t3.acquired).toBe(true);
    expect(q.waiting).toBe(0);
  });

  it("higher tier overtakes lower tier regardless of arrival order", () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const holder = q.enqueue(1);
    const freeFirst = q.enqueue(2, "free");
    const vipLate = q.enqueue(3, "vip");

    q.release(holder);
    expect(vipLate.acquired).toBe(true);
    expect(freeFirst.acquired).toBe(false);
    expect(q.position(freeFirst)).toBe(1);
  });

  it("aging lets a long-waiting free request overtake a fresh vip", async () => {
    const q = new WeightedAdmissionQueue(baseOpts({ agingWindowMs: 10, agingStep: 1000 }));
    const holder = q.enqueue(1);
    const patientFree = q.enqueue(2, "free");
    await sleep(35); // ~3 aging windows → +3000 effective weight
    const freshVip = q.enqueue(3, "vip");

    q.release(holder);
    expect(patientFree.acquired).toBe(true);
    expect(freshVip.acquired).toBe(false);
  });

  it("rejects immediately with QueueFullError when the queue is at capacity", () => {
    const q = new WeightedAdmissionQueue({ ...baseOpts(), queueMaxSize: 2 });
    q.enqueue(1); // holds the only slot
    q.enqueue(2);
    q.enqueue(3);
    expect(() => q.enqueue(4)).toThrow(QueueFullError);
    expect(q.waiting).toBe(2);
  });

  it("cancel removes a queued ticket without touching slots", () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const holder = q.enqueue(1);
    const queued = q.enqueue(2);
    q.cancel(queued);
    expect(queued.cancelled).toBe(true);
    expect(q.waiting).toBe(0);

    q.release(holder); // nobody left to wake
    expect(q.running).toBe(0);
    expect(queued.acquired).toBe(false);
  });

  it("release/cancel on a non-acquired ticket is a safe no-op", () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const holder = q.enqueue(1);
    const queued = q.enqueue(2);

    q.release(queued); // never acquired
    expect(q.running).toBe(1);
    expect(q.waiting).toBe(1);

    q.cancel(holder); // acquired tickets are not cancellable
    expect(holder.acquired).toBe(true);
    expect(q.running).toBe(1);
  });

  it("position reflects queue order including priority", () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const holder = q.enqueue(1);
    const free = q.enqueue(2, "free");
    const vip = q.enqueue(3, "vip");

    expect(q.position(vip)).toBe(1);
    expect(q.position(free)).toBe(2);
    expect(q.position(holder)).toBe(0);

    q.release(holder);
    expect(q.position(vip)).toBe(0);
    expect(q.position(free)).toBe(1);
  });

  it("stats reports active/waiting split by tier", () => {
    const q = new WeightedAdmissionQueue({ ...baseOpts(), maxConcurrent: 2 });
    q.enqueue(1);
    q.enqueue(2, "vip");
    const t3 = q.enqueue(3, "free");
    const t4 = q.enqueue(4, "svip");
    void t3;
    void t4;

    expect(q.stats()).toEqual({
      active: 2,
      maxConcurrent: 2,
      queueLen: 2,
      queueMaxSize: 5,
      waitingByTier: { free: 1, svip: 1 },
    });
  });

  it("ticket.wait resolves true on grant and false on progress ticks", async () => {
    const q = new WeightedAdmissionQueue(baseOpts());
    const holder = q.enqueue(1);
    const queued = q.enqueue(2);

    const tick = await queued.wait(5);
    expect(tick).toBe(false);

    q.release(holder);
    const granted = await queued.wait(1000);
    expect(granted).toBe(true);
    expect(queued.acquired).toBe(true);
  });
});
