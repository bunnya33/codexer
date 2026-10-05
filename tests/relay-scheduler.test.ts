import { describe, expect, it } from "vitest";
import { RelayScheduler } from "../apps/relay/src/concurrency/scheduler.js";
import { RelayMetrics } from "../apps/relay/src/observability/metrics.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Relay device scheduler", () => {
  it("runs different devices independently and preserves order for the same device", async () => {
    const metrics = new RelayMetrics();
    const scheduler = new RelayScheduler(metrics);
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    const first = scheduler.runDevice("a", async () => {
      entered.resolve();
      await gate.promise;
      order.push("a1");
    });
    await entered.promise;
    const second = scheduler.runDevice("a", async () => {
      order.push("a2");
    });
    await scheduler.runDevice("b", async () => {
      order.push("b1");
    });
    expect(order).toEqual(["b1"]);
    expect(scheduler.snapshot().lanes.device).toMatchObject({ running: 1, waiting: 1 });
    gate.resolve();
    await Promise.all([first, second]);
    await scheduler.drain();
    expect(order).toEqual(["b1", "a1", "a2"]);
    expect(scheduler.snapshot().deviceQueues).toBe(0);
    expect(metrics.snapshot().queues.device!.run.count).toBe(3);
  });

  it("orders an identity barrier between existing tasks and later device tasks", async () => {
    const scheduler = new RelayScheduler(new RelayMetrics());
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    const before = scheduler.runDevice("a", async () => {
      entered.resolve();
      await gate.promise;
      order.push("before");
    });
    await entered.promise;
    const barrier = scheduler.run(async () => {
      order.push("revoked");
    });
    const after = scheduler.runDevice("b", async () => {
      order.push("after");
    });
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([before, barrier, after]);
    expect(order).toEqual(["before", "revoked", "after"]);
  });

  it("recovers from failed tasks and drains maintenance work independently of device work", async () => {
    const scheduler = new RelayScheduler(new RelayMetrics());
    const gate = deferred();
    const entered = deferred();
    const maintenance = scheduler.runMaintenance(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    await expect(
      scheduler.runDevice("a", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await scheduler.runDevice("a", async () => undefined);
    let drained = false;
    const drain = scheduler.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([maintenance, drain]);
    expect(scheduler.snapshot().lanes.device).toMatchObject({
      completed: 1,
      failed: 1,
      waiting: 0,
      running: 0,
    });
  });

  it("registers client dependencies before an identity barrier without a nested-queue deadlock", async () => {
    const scheduler = new RelayScheduler(new RelayMetrics());
    const gate = deferred();
    const first = scheduler.runDevice("a", () => gate.promise);
    const order: string[] = [];
    const second = scheduler.runDevice(
      "b",
      async () => {
        order.push("client-second");
      },
      first,
    );
    const barrier = scheduler.run(async () => {
      order.push("barrier");
    });
    gate.resolve();
    await Promise.all([first, second, barrier]);
    expect(order).toEqual(["client-second", "barrier"]);
  });
});
