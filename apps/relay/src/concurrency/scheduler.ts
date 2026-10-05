import { performance } from "node:perf_hooks";
import type { QueueLane, RelayMetrics } from "../observability/metrics.js";

/**
 * 设备任务按键串行，不同键并行。身份变更建立屏障：等待此前任务完成，
 * 后来的设备任务等待屏障，避免改密/禁用后继续转发旧身份的指令。
 * 所有依赖在入队时登记，设备/屏障任务不得嵌套并等待本调度器，否则会形成循环等待。
 */
export class RelayScheduler {
  private readonly devices = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly maintenancePending = new Set<Promise<unknown>>();
  private barrier: Promise<unknown> = Promise.resolve();
  private maintenanceTail: Promise<unknown> = Promise.resolve();
  private readonly lanes = {
    device: { waiting: 0, running: 0, completed: 0, failed: 0 },
    exclusive: { waiting: 0, running: 0, completed: 0, failed: 0 },
    maintenance: { waiting: 0, running: 0, completed: 0, failed: 0 },
  };

  constructor(private readonly metrics: RelayMetrics) {}

  runDevice<T>(
    deviceId: string,
    operation: () => Promise<T>,
    after?: Promise<unknown>,
  ): Promise<T> {
    const result = this.schedule(
      "device",
      [this.barrier, this.devices.get(deviceId), after],
      operation,
    );
    const settled = result.catch(() => undefined);
    this.devices.set(deviceId, settled);
    void settled.then(() => {
      if (this.devices.get(deviceId) === settled) this.devices.delete(deviceId);
    });
    this.track(settled, this.pending);
    return result;
  }

  /** 账号/会话变更与所有已经登记的设备任务保持原有先后关系。 */
  run<T>(operation: () => Promise<T>, after?: Promise<unknown>): Promise<T> {
    const result = this.schedule("exclusive", [this.barrier, ...this.pending, after], operation);
    this.barrier = result.catch(() => undefined);
    this.track(this.barrier, this.pending);
    return result;
  }

  /** 清理不进入身份屏障，避免扫描过期数据时阻塞所有设备。 */
  runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.schedule("maintenance", [this.maintenanceTail], operation);
    this.maintenanceTail = result.catch(() => undefined);
    this.track(this.maintenanceTail, this.maintenancePending);
    return result;
  }

  private schedule<T>(
    lane: QueueLane,
    dependencies: (Promise<unknown> | undefined)[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    const stats = this.lanes[lane];
    stats.waiting++;

    return Promise.allSettled(dependencies).then(async () => {
      stats.waiting--;
      stats.running++;
      const startedAt = performance.now();
      this.metrics.observeQueue(lane, "wait", startedAt - enqueuedAt);

      try {
        const result = await operation();
        stats.completed++;
        return result;
      } catch (error) {
        stats.failed++;
        throw error;
      } finally {
        stats.running--;
        this.metrics.observeQueue(lane, "run", performance.now() - startedAt);
      }
    });
  }

  private track(promise: Promise<unknown>, collection: Set<Promise<unknown>>): void {
    collection.add(promise);
    void promise.then(() => collection.delete(promise));
  }

  async drain(): Promise<void> {
    while (this.pending.size || this.maintenancePending.size) {
      await Promise.all([...this.pending, ...this.maintenancePending]);
    }
  }

  snapshot() {
    return {
      deviceQueues: this.devices.size,
      lanes: Object.fromEntries(
        Object.entries(this.lanes).map(([lane, stats]) => [lane, { ...stats }]),
      ),
    };
  }
}
