import { WebSocket } from "ws";
import { HttpError } from "../core/errors.js";
import type { FastifyInstance } from "fastify";
import type { RelayContext } from "../core/context.js";

/** 心跳与分批清理独立运行；关闭时停止新维护轮次，再排空全部设备任务。 */
export function registerLifecycle(app: FastifyInstance, context: RelayContext): void {
  const store = context.store;
  const queue = context.queue;
  const options = context.options;
  const weixin = context.weixin;
  const agents = context.connections.agents;
  const clients = context.connections.clients;
  const pendingHistory = context.connections.pendingHistory;
  const pendingImages = context.connections.pendingImages;
  const pendingFiles = context.connections.pendingFiles;
  const broadcast = context.connections.broadcast;
  const closeSessions = context.connections.closeSessions;
  const cleanupController = new AbortController();
  let checkingSessions = false;
  let cleaning = false;

  app.addHook("onReady", async () => context.metrics.start());

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of [...agents.values(), ...clients]) {
      if (now - connection.lastPong > 45000) connection.socket.terminate();
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
    }
    if (checkingSessions || context.closing) return;
    checkingSessions = true;
    void queue
      .runMaintenance(async () => {
        for (const client of clients)
          if (client.principal && !(await store.sessionForHash(client.principal.sessionHash!)))
            closeSessions(
              (value) => value.sessionHash === client.principal!.sessionHash,
              "session-expired",
            );
        const checks = [...agents].map(([id, agent]) =>
          queue.runDevice(id, async () => {
            if (agents.get(id) !== agent) return;
            if (!(await store.sessionForHash(agent.principal.sessionHash!, id))) {
              closeSessions(
                (value) => value.sessionHash === agent.principal.sessionHash,
                "session-expired",
              );
            }
          }),
        );
        for (const deviceId of await store.expiredCommandDevices()) {
          checks.push(
            queue.runDevice(deviceId, async () => {
              // 超时状态写入也排在已有回包之后，防止覆盖已收到但尚未处理的成功结果。
              for (const result of await store.expireCommands(deviceId)) {
                broadcast(deviceId, { type: "command.result", result });
                await store.weixin.commandResult(result);
              }
            }),
          );
        }
        await Promise.allSettled(checks);
      })
      .catch(() => undefined)
      .finally(() => {
        checkingSessions = false;
      });
  }, options.heartbeatMs ?? 15000);

  heartbeat.unref();

  let cleanup: NodeJS.Timeout | undefined;
  const scheduleCleanup = (delay: number) => {
    if (context.closing) return;
    cleanup = setTimeout(runCleanup, delay);
    cleanup.unref();
  };
  const runCleanup = () => {
    if (cleaning || context.closing) return;
    cleaning = true;
    let nextDelay = options.cleanupMs ?? 3600000;
    void queue
      .runMaintenance(() => store.cleanup({ signal: cleanupController.signal }))
      .then((summary) => {
        // 本轮达到预算时尽快续跑，避免大量过期记录等待下一小时。
        if (Object.values(summary).some((table) => table.capped))
          nextDelay = options.cleanupRetryMs ?? 5000;
      })
      .catch(() => undefined)
      .finally(() => {
        cleaning = false;
        scheduleCleanup(nextDelay);
      });
  };

  scheduleCleanup(options.cleanupMs ?? 3600000);

  app.addHook("preClose", async () => {
    context.closing = true;
    clearInterval(heartbeat);
    clearTimeout(cleanup);
    cleanupController.abort();
    await weixin?.stop();
    for (const client of clients) {
      clearTimeout(client.authTimer);
      context.connections.removeClient(client);
      client.socket.terminate();
    }
    for (const agent of agents.values()) agent.socket.terminate();
    for (const pending of pendingHistory.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, "relay-closing"));
    }
    pendingHistory.clear();
    for (const pending of pendingImages.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, "relay-closing"));
    }
    pendingImages.clear();
    for (const pending of pendingFiles.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, "relay-closing"));
    }
    pendingFiles.clear();
    for (const pending of context.connections.pendingPreviews.values())
      pending.reject(new HttpError(503, "relay-closing"));
    context.connections.pendingPreviews.clear();
    await queue.drain();
  });

  app.addHook("onClose", async () => {
    await store.close();
  });
}
