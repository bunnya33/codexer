import { randomInt } from "node:crypto";
import { z } from "zod";

// Wire format published by Tencent/openclaw-weixin (2.4.9). This adapter does
// not run OpenClaw; bot_agent identifies the actual client as Codexer.
export const WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const channelVersion = "2.4.9";
const messageSchema = z.object({
  message_id: z.union([z.string(), z.number()]).optional(),
  seq: z.union([z.string(), z.number()]).optional(),
  from_user_id: z.string().max(256).optional(),
  message_type: z.number().optional(),
  message_state: z.number().optional(),
  create_time_ms: z.number().optional(),
  context_token: z.string().max(16384).optional(),
  group_id: z.string().optional(),
  item_list: z
    .array(
      z.object({
        type: z.number(),
        text_item: z.object({ text: z.string().max(32000) }).optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type WeixinMessage = z.infer<typeof messageSchema>;
const qrStatusSchema = z.object({
  status: z.enum([
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "need_verifycode",
    "verify_code_blocked",
    "scaned_but_redirect",
    "binded_redirect",
  ]),
  bot_token: z.string().max(16384).optional(),
  ilink_bot_id: z.string().max(256).optional(),
  ilink_user_id: z.string().max(256).optional(),
  baseurl: z.string().max(2048).optional(),
  redirect_host: z.string().max(256).optional(),
});
export type WeixinQrStatus = z.infer<typeof qrStatusSchema>;
export type WeixinCredentials = { token: string; baseUrl: string };
export interface WeixinTransport {
  qr(signal: AbortSignal): Promise<{ qrcode: string; qrcode_img_content: string }>;
  qrStatus(
    baseUrl: string,
    qrcode: string,
    signal: AbortSignal,
    verifyCode?: string,
  ): Promise<WeixinQrStatus>;
  updates(
    credentials: WeixinCredentials,
    cursor: string,
    signal: AbortSignal,
  ): Promise<{ msgs: WeixinMessage[]; get_updates_buf?: string }>;
  send(
    credentials: WeixinCredentials,
    peerId: string,
    text: string,
    contextToken: string,
    clientId: string,
    signal: AbortSignal,
  ): Promise<void>;
}
export class WeixinError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 502,
  ) {
    super(code);
  }
}
export function weixinUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinError("weixin-invalid-host");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".weixin.qq.com")
  )
    throw new WeixinError("weixin-invalid-host");
  return url.origin;
}

export class WeixinApi implements WeixinTransport {
  constructor(
    private readonly version = "0.2.1",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    baseUrl: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    token?: string,
    timeout = 15000,
  ): Promise<unknown> {
    const authenticated = Boolean(token),
      post = body !== undefined;
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 9),
    };
    if (post) {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomInt(0, 0x1_0000_0000))).toString("base64");
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = authenticated
      ? {
          ...(body as object),
          base_info: { channel_version: channelVersion, bot_agent: `Codexer/${this.version}` },
        }
      : body;
    const validatedBase = weixinUrl(baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(`${validatedBase}/${path}`, {
        method: post ? "POST" : "GET",
        headers,
        ...(post ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        redirect: "error",
      });
    } catch {
      throw new WeixinError("weixin-network-error");
    }
    if (!response.ok) throw new WeixinError("weixin-http-error");
    // Bound even a chunked response; never log the response body or credentials.
    const reader = response.body?.getReader();
    if (!reader) throw new WeixinError("weixin-invalid-response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new WeixinError("weixin-response-too-large");
        }
        chunks.push(part.value);
      }
      const text = Buffer.concat(chunks)
        .toString("utf8")
        .replace(/"(message_id|seq)"\s*:\s*(\d{16,})/g, '"$1":"$2"');
      const value = JSON.parse(text) as Record<string, unknown>;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        [value.ret, value.errcode].some(
          (v) => v !== undefined && (typeof v !== "number" || !Number.isInteger(v)),
        )
      )
        throw new WeixinError("weixin-invalid-response");
      if (value.ret === -14 || value.errcode === -14)
        throw new WeixinError("weixin-session-expired");
      if (
        (typeof value.ret === "number" && value.ret !== 0) ||
        (typeof value.errcode === "number" && value.errcode !== 0)
      )
        throw new WeixinError("weixin-api-error");
      return value;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      throw new WeixinError("weixin-invalid-response");
    } finally {
      reader.releaseLock();
    }
  }

  async qr(signal: AbortSignal) {
    return z
      .object({
        qrcode: z.string().min(1).max(4096),
        qrcode_img_content: z.string().min(1).max(8192),
      })
      .parse(
        await this.request(
          WEIXIN_BASE_URL,
          "ilink/bot/get_bot_qrcode?bot_type=3",
          { local_token_list: [] },
          signal,
        ),
      );
  }

  async qrStatus(baseUrl: string, qrcode: string, signal: AbortSignal, verifyCode?: string) {
    return qrStatusSchema.parse(
      await this.request(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`,
        undefined,
        signal,
        undefined,
        35000,
      ),
    );
  }

  async updates(credentials: WeixinCredentials, cursor: string, signal: AbortSignal) {
    return z
      .object({
        msgs: z.array(messageSchema).max(1000).default([]),
        get_updates_buf: z
          .string()
          .max(1024 * 1024)
          .optional(),
      })
      .parse(
        await this.request(
          credentials.baseUrl,
          "ilink/bot/getupdates",
          { get_updates_buf: cursor },
          signal,
          credentials.token,
          40000,
        ),
      );
  }

  async send(
    credentials: WeixinCredentials,
    peerId: string,
    text: string,
    contextToken: string,
    clientId: string,
    signal: AbortSignal,
  ) {
    await this.request(
      credentials.baseUrl,
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: peerId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: text.slice(0, 3900) } }],
        },
      },
      signal,
      credentials.token,
    );
  }
}
