import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { RemoteCommand } from "../../../../packages/protocol/src/index.js";
import type { WeixinLogin, WeixinStatus } from "../../../../packages/protocol/src/weixin.js";
import { WeixinApi, WeixinError, WEIXIN_BASE_URL, weixinUrl } from "./api.js";
import type { WeixinTransport, WeixinMessage } from "./api.js";
import { WeixinSecrets } from "./secrets.js";
import type { WeixinBinding } from "./repository.js";
import type { RelayStore } from "../storage/store.js";

type Login = WeixinLogin & {
  userId: string;
  qrcode: string;
  baseUrl: string;
  controller: AbortController;
  polling: boolean;
};
type Runner = { userId: string; controller: AbortController; tasks: Promise<void>[] };
export type WeixinOptions = { key: Buffer; api?: WeixinTransport; intervalMs?: number };
type Dispatch = (userId: string, bindingId: string, command: RemoteCommand) => Promise<unknown>;
type Reply = { text: string; targetCode?: string };
function code(error: unknown): string {
  return error instanceof WeixinError ? error.code : "weixin-unavailable";
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}
const help =
  "Codexer 微信助手\n直接回复下一步要求，继续最近收到通知或提交确认的会话。\n发送「设备」查看电脑；发送「会话」或「会话 2」查看会话编号。\n切换会话可发送「继续 C会话编号 下一步要求」。\n审批与提问请在 Codexer 中处理。";

/**
 * 每个绑定独立维护收取与发送任务，重试可通过 AbortSignal 取消。
 * 收到的指令必须重新验证绑定、设备归属与时效，不能重放离线积压指令。
 */
export class WeixinService {
  private readonly api: WeixinTransport;
  private readonly secrets: WeixinSecrets;
  private readonly logins = new Map<string, Login>();
  private readonly runners = new Map<string, Runner>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private reconciling = false;

  constructor(
    private readonly store: RelayStore,
    options: WeixinOptions,
    private readonly dispatch: Dispatch,
    private readonly online: (deviceId: string) => boolean,
  ) {
    this.api = options.api ?? new WeixinApi();
    this.secrets = new WeixinSecrets(options.key);
    this.intervalMs = options.intervalMs ?? 1000;
  }
  private readonly intervalMs: number;

  private scope(b: Pick<WeixinBinding, "id" | "userId">, field: string) {
    return `${b.userId}:${b.id}:${field}`;
  }

  async start() {
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const login of this.logins.values()) login.controller.abort();
    this.logins.clear();
    const tasks = [...this.runners.values()].flatMap((r) => {
      r.controller.abort();
      return r.tasks;
    });
    await Promise.allSettled(tasks);
    this.runners.clear();
  }

  private async reconcile() {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const bindings = await this.store.weixin.active();
      if (this.stopped) return;
      const ids = new Set(bindings.map((b) => b.id));
      for (const [id, r] of this.runners)
        if (!ids.has(id)) {
          r.controller.abort();
          this.runners.delete(id);
        }
      for (const b of bindings)
        if (!this.runners.has(b.id)) {
          const r: Runner = { userId: b.userId, controller: new AbortController(), tasks: [] };
          this.runners.set(b.id, r);
          r.tasks = [this.poll(b, r.controller.signal), this.send(b, r.controller.signal)];
          for (const task of r.tasks) void task.catch(() => undefined);
        }
      for (const [id, l] of this.logins)
        if (l.expiresAt < Date.now()) {
          l.controller.abort();
          this.logins.delete(id);
        }
    } finally {
      this.reconciling = false;
    }
  }

  async status(userId: string): Promise<WeixinStatus> {
    const b = await this.store.weixin.get(userId);
    if (!b)
      return {
        available: true,
        bound: false,
        connected: false,
        activated: false,
        notifications: true,
        replies: true,
        lastError: null,
        pendingNotifications: 0,
      };
    return {
      available: true,
      bound: true,
      botId: b.botId,
      connected: !b.pollError && b.lastPollAt !== null && Date.now() - b.lastPollAt < 90000,
      activated: Boolean(b.context),
      notifications: b.notifications,
      replies: b.replies,
      lastError: b.pollError ?? b.sendError,
      pendingNotifications: await this.store.weixin.pending(b.id),
    };
  }

  private loginView(l: Login): WeixinLogin {
    return { loginId: l.loginId, status: l.status, qrImage: l.qrImage, expiresAt: l.expiresAt };
  }

  async startLogin(userId: string): Promise<WeixinLogin> {
    if (this.stopped) throw new WeixinError("weixin-unavailable", 503);
    const old = this.logins.get(userId);
    old?.controller.abort();
    if (!old && this.logins.size >= 1000) throw new WeixinError("weixin-login-busy", 429);
    const l: Login = {
      userId,
      loginId: randomUUID(),
      qrcode: "",
      baseUrl: WEIXIN_BASE_URL,
      status: "wait",
      expiresAt: Date.now() + 300000,
      controller: new AbortController(),
      polling: false,
    };
    this.logins.set(userId, l);
    try {
      const qr = await this.api.qr(l.controller.signal);
      if (
        this.logins.get(userId) !== l ||
        l.controller.signal.aborted ||
        !(await this.store.userActive(userId))
      )
        throw new WeixinError("weixin-login-expired", 409);
      l.qrcode = qr.qrcode;
      l.qrImage = await QRCode.toDataURL(qr.qrcode_img_content, { width: 256, margin: 2 });
      return this.loginView(l);
    } catch (error) {
      if (this.logins.get(userId) === l) this.logins.delete(userId);
      throw error instanceof WeixinError ? error : new WeixinError("weixin-unavailable");
    }
  }

  async pollLogin(userId: string, loginId: string, verifyCode?: string): Promise<WeixinLogin> {
    const l = this.logins.get(userId);
    if (!l || l.loginId !== loginId) throw new WeixinError("weixin-login-not-found", 404);
    if (l.expiresAt < Date.now()) {
      l.status = "expired";
      return this.loginView(l);
    }
    if (
      l.status === "confirmed" ||
      l.status === "expired" ||
      l.status === "verify_code_blocked" ||
      l.polling
    )
      return this.loginView(l);
    l.polling = true;
    try {
      const result = await this.api.qrStatus(l.baseUrl, l.qrcode, l.controller.signal, verifyCode);
      if (
        this.logins.get(userId) !== l ||
        l.controller.signal.aborted ||
        l.expiresAt < Date.now() ||
        !(await this.store.userActive(userId))
      )
        throw new WeixinError("weixin-login-expired", 409);
      if (result.status === "scaned_but_redirect") {
        if (!result.redirect_host) throw new WeixinError("weixin-invalid-response");
        l.baseUrl = weixinUrl(`https://${result.redirect_host}`);
        l.status = "scaned";
      } else if (result.status === "binded_redirect")
        throw new WeixinError("weixin-already-connected", 409);
      else if (result.status === "confirmed") {
        if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id)
          throw new WeixinError("weixin-invalid-response");
        const b = {
          id: randomUUID(),
          userId,
          botId: result.ilink_bot_id,
          peerId: result.ilink_user_id,
          baseUrl: weixinUrl(result.baseurl ?? l.baseUrl),
        };
        await this.store.weixin.bind({
          ...b,
          token: this.secrets.seal(result.bot_token, this.scope(b, "token")),
        });
        l.status = "confirmed";
        l.qrImage = undefined;
        await this.reconcile();
      } else l.status = result.status;
      return this.loginView(l);
    } finally {
      l.polling = false;
    }
  }

  async unbind(userId: string) {
    this.logins.get(userId)?.controller.abort();
    this.logins.delete(userId);
    for (const r of this.runners.values()) if (r.userId === userId) r.controller.abort();
    await this.store.weixin.unbind(userId);
    await this.reconcile();
  }

  async settings(userId: string, notifications: boolean, replies: boolean) {
    if (!(await this.store.weixin.get(userId))) throw new WeixinError("weixin-not-bound", 409);
    await this.store.weixin.settings(userId, notifications, replies);
    return this.status(userId);
  }

  async test(userId: string) {
    const b = await this.store.weixin.get(userId);
    if (!b) throw new WeixinError("weixin-not-bound", 409);
    if (!b.context) throw new WeixinError("weixin-not-activated", 409);
    await this.store.weixin.enqueue(
      b.id,
      `test:${randomUUID()}`,
      "test",
      "Codexer 微信连接测试：你的账号已绑定。所属电脑的任务完成后，会在这里发送设备、项目、会话和结果摘要。",
    );
    return { queued: true };
  }

  private credentials(b: WeixinBinding) {
    return { baseUrl: b.baseUrl, token: this.secrets.open(b.token, this.scope(b, "token")) };
  }

  private async current(b: WeixinBinding, signal: AbortSignal): Promise<WeixinBinding | null> {
    if (signal.aborted || this.stopped) return null;
    const current = await this.store.weixin.get(b.userId);
    return current?.id === b.id && !signal.aborted && !this.stopped ? current : null;
  }

  private async poll(original: WeixinBinding, signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted && !this.stopped) {
      try {
        const b = await this.current(original, signal);
        if (!b) return;
        const cursor = b.cursor ? this.secrets.open(b.cursor, this.scope(b, "cursor")) : "";
        const response = await this.api.updates(this.credentials(b), cursor, signal);
        if (!(await this.current(b, signal))) return;
        for (const message of response.msgs) {
          if (!(await this.current(b, signal))) return;
          await this.receive(b, message, signal);
        }
        await this.store.weixin.polled(
          b.id,
          response.get_updates_buf
            ? this.secrets.seal(response.get_updates_buf, this.scope(b, "cursor"))
            : undefined,
        );
        failures = 0;
        await pause(Math.min(this.intervalMs, 1000), signal);
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        await this.store.weixin.error(original.id, "poll", code(error)).catch(() => undefined);
        await pause(
          code(error) === "weixin-session-expired"
            ? 3600000
            : Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)),
          signal,
        );
      }
    }
  }

  private async reply(b: WeixinBinding, id: string, text: string, targetCode?: string) {
    await this.store.weixin.enqueue(b.id, `reply:${id}`, "reply", text, targetCode);
  }

  private async receive(b: WeixinBinding, msg: WeixinMessage, signal: AbortSignal) {
    if (
      msg.message_type !== 1 ||
      msg.from_user_id !== b.peerId ||
      msg.group_id ||
      (msg.message_state != null && ![0, 2].includes(msg.message_state))
    )
      return;
    const id = msg.message_id ?? msg.seq;
    if (id == null) return;
    if (!(await this.store.weixin.claim(b.id, String(id)))) return;
    if (msg.context_token)
      await this.store.weixin.polled(
        b.id,
        undefined,
        this.secrets.seal(msg.context_token, this.scope(b, "context")),
      );
    const text =
      msg.item_list
        ?.filter((item) => item.type === 1)
        .map((item) => item.text_item?.text ?? "")
        .join("\n")
        .trim() ?? "";
    if (!text) {
      await this.reply(b, String(id), "目前支持文字指令。\n" + help);
      return;
    }
    try {
      const response = await this.handleText(b, text, msg.create_time_ms, String(id), signal);
      await this.reply(b, String(id), response.text, response.targetCode);
    } catch (error) {
      if (!signal.aborted && (await this.store.weixin.current(b.id, b.userId)))
        await this.reply(b, String(id), this.commandError(error));
    }
  }

  private commandError(error: unknown) {
    const value = error instanceof Error ? error.message : "";
    if (value === "device-offline") return "目标电脑离线，指令未提交。请启动 PC 连接器后重新发送。";
    if (value === "device-not-found" || value === "weixin-target-not-found")
      return "找不到这个账号下的会话编号。发送「会话」查看你的会话。";
    if (value === "weixin-replies-disabled")
      return "微信续做已关闭，请在 Codexer 的微信设置中开启。";
    if (value === "weixin-thread-unavailable")
      return "会话暂不可操作，请先在 Codexer 打开该会话，确认连接后再试。";
    return "指令未确认，请打开 Codexer 核对会话状态后再试。";
  }

  private async handleText(
    b: WeixinBinding,
    text: string,
    timestamp: number | undefined,
    messageId: string,
    signal: AbortSignal,
  ): Promise<Reply> {
    const principal = { id: b.userId, kind: "user" as const };
    if (/^(帮助|help|你好|开始)$/i.test(text)) return { text: help };
    if (text === "设备") {
      const devices = await this.store.listDevices(principal);
      return {
        text: devices.length
          ? devices
              .map((d) => `${String(d.name)} · ${this.online(String(d.id)) ? "在线" : "离线"}`)
              .join("\n") + "\n\n发送「会话」选择任务。"
          : "这个账号还没有电脑，请先让 PC 连接器登录。",
      };
    }
    const list = /^(?:会话|列表)(?:\s+(\d{1,4}))?$/.exec(text);
    if (list) {
      const all = [];
      for (const d of await this.store.listDevices(principal)) {
        const catalog = await this.store.catalog(String(d.id));
        for (const t of catalog?.threads ?? [])
          if (!t.archived)
            all.push({
              device: d,
              thread: t,
              project:
                catalog?.projects.find((p) => p.id === t.projectId)?.name ?? t.cwd ?? "未分组项目",
            });
      }
      all.sort((a, c) => c.thread.updatedAt - a.thread.updatedAt);
      const page = Math.max(1, Number(list[1] ?? 1)),
        entries = all.slice((page - 1) * 10, page * 10);
      if (!entries.length)
        return {
          text: all.length
            ? "这一页没有会话。发送「会话」查看第一页。"
            : "还没有同步会话，请让 PC 连接器在线并打开项目。",
        };
      const lines = [];
      for (const entry of entries) {
        const id = await this.store.weixin.target(
          b.userId,
          String(entry.device.id),
          entry.thread.id,
        );
        lines.push(
          `${id} · ${String(entry.device.name).slice(0, 80)}${this.online(String(entry.device.id)) ? "" : "（离线）"}\n${entry.project.slice(0, 100)} / ${entry.thread.title.slice(0, 150)}`,
        );
      }
      return {
        text: `会话 ${page}/${Math.ceil(all.length / 10)}\n\n${lines.join("\n\n")}\n\n发送「继续 编号 下一步要求」切换会话；直接回复要求继续最近的会话。发送「会话 页码」翻页。`,
      };
    }
    const request = /^继续\s+(C[A-F0-9]{8})\s+([\s\S]+)$/i.exec(text);
    // 看起来在指定编号却未写完整时提示用法，避免把编号当作普通任务下发。
    if (!request && /^继续\s+C\S*(?:\s|$)/i.test(text)) return { text: help };
    const current = await this.current(b, signal);
    if (!current) throw new WeixinError("weixin-account-inactive");
    if (!current.replies) throw new WeixinError("weixin-replies-disabled");
    // Do not execute backlog instructions after a disconnect/restart. A new
    // instruction must have a recent timestamp and an account-owned target.
    if (
      timestamp == null ||
      !Number.isFinite(timestamp) ||
      Date.now() - timestamp > 300000 ||
      timestamp > Date.now() + 60000
    )
      return { text: "这条指令已过期，未执行。请重新发送你的下一步要求。" };
    const targetCode = request?.[1]?.toUpperCase();
    const explicitTarget = targetCode
      ? await this.store.weixin.resolve(b.userId, targetCode)
      : null;
    const target = targetCode
      ? explicitTarget && { ...explicitTarget, code: targetCode }
      : await this.store.weixin.replyTarget(b.id, b.userId);
    if (!target) {
      if (targetCode) throw new WeixinError("weixin-target-not-found");
      return {
        text: "还没有可直接回复的会话。收到任务完成通知后可直接回复，或发送「会话」查看编号，再用「继续 编号 下一步要求」指定会话。",
      };
    }
    if (!this.online(target.deviceId)) throw new WeixinError("device-offline");
    const catalog = await this.store.catalog(target.deviceId);
    if (!catalog?.threads.some((t) => t.id === target.threadId && !t.archived))
      throw new WeixinError("weixin-target-not-found");
    let snapshot = await this.store.snapshot(target.deviceId);
    if (snapshot && !snapshot.threads[target.threadId]) {
      const watch: RemoteCommand = {
        commandId: randomUUID(),
        deviceId: target.deviceId,
        expectedEpoch: snapshot.epoch,
        expiresAt: Date.now() + 60000,
        payload: { type: "thread.watch", threadId: target.threadId },
      };
      await this.dispatch(b.userId, b.id, watch);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !signal.aborted) {
        const result = await this.store.command(watch.deviceId, watch.commandId);
        if (result?.status !== "pending") break;
        await pause(100, signal);
      }
      snapshot = await this.store.snapshot(target.deviceId);
    }
    const thread = snapshot?.threads[target.threadId];
    if (
      !snapshot?.runtime.connected ||
      !snapshot.runtime.capabilities.startTurn ||
      !thread?.ownerAvailable ||
      !["idle", "active"].includes(thread.status)
    )
      throw new WeixinError("weixin-thread-unavailable");
    const command: RemoteCommand = {
      commandId: randomUUID(),
      deviceId: target.deviceId,
      expectedEpoch: snapshot.epoch,
      expiresAt: Date.now() + 60000,
      payload: {
        type: thread.status === "active" ? "turn.queue" : "turn.start",
        threadId: target.threadId,
        text: request ? request[2]!.trim() : text,
      },
    };
    await this.store.weixin.command(b.id, messageId, command);
    const result = (await this.dispatch(b.userId, b.id, command)) as { type?: string };
    if (result.type === "command.result")
      return { text: "指令的提交结果尚未确认，请打开 Codexer 查看实际状态。" };
    return {
      text: `${thread.status === "active" ? "已提交排队请求" : "已提交续做指令"}：${target.code} / ${thread.title.slice(0, 150)}。\n任务完成后会另行通知。`,
      targetCode: target.code,
    };
  }

  private async send(original: WeixinBinding, signal: AbortSignal) {
    while (!signal.aborted && !this.stopped) {
      try {
        const b = await this.current(original, signal);
        if (!b) return;
        const item = await this.store.weixin.next(b.id);
        if (!item) {
          await pause(this.intervalMs, signal);
          continue;
        }
        if (Date.now() - item.createdAt > 86400000) {
          await this.store.weixin.retry(
            b.id,
            item.id,
            "weixin-notification-expired",
            item.attempts,
            true,
          );
          continue;
        }
        if (
          item.deviceId &&
          !(await this.store.ownsDevice(item.deviceId, { id: b.userId, kind: "user" }))
        ) {
          await this.store.weixin.retry(b.id, item.id, "device-not-found", item.attempts, true);
          continue;
        }
        if (!b.context) {
          await pause(this.intervalMs, signal);
          continue;
        }
        if (item.kind === "completion" && !b.notifications) {
          await this.store.weixin.delivered(b.id, item.id, false);
          continue;
        }
        try {
          const context = this.secrets.open(b.context, this.scope(b, "context"));
          if (!(await this.current(b, signal))) return;
          await this.api.send(
            this.credentials(b),
            b.peerId,
            item.text,
            context,
            item.clientId,
            signal,
          );
          if (!signal.aborted) await this.store.weixin.delivered(b.id, item.id);
        } catch (error) {
          if (signal.aborted || this.stopped) return;
          await this.store.weixin.retry(
            b.id,
            item.id,
            code(error),
            item.attempts + 1,
            item.attempts >= 11,
          );
        }
        await pause(this.intervalMs, signal);
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        await this.store.weixin.error(original.id, "send", code(error)).catch(() => undefined);
        await pause(5000, signal);
      }
    }
  }
}
