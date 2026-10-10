import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocket } from 'ws';
import { localPreviewUrl, previewReferences } from '../../client-shared/src/previews.js';
import { MAX_PREVIEW_RESPONSE_BYTES, PREVIEW_CHUNK_BYTES, previewRequestSchema, previewSocketSchema } from '../../protocol/src/previews.js';
import type { PreviewResponse } from '../../protocol/src/previews.js';
import type { HistoryTurn, RemoteThread } from '../../protocol/src/index.js';

export class PreviewRegistry {
  private origins = new Map<string, Set<string>>();
  observe(thread: Pick<RemoteThread, 'id' | 'turns'>) { thread.turns.forEach(turn => this.observeTurn(thread.id, turn)); }
  observeTurn(threadId: string, turn: Pick<HistoryTurn, 'items'>) {
    const origins = this.origins.get(threadId) ?? new Set<string>();
    for (const item of turn.items) {
      for (const source of [item.text, item.output]) {
        for (const preview of previewReferences(source ?? '')) if (preview.kind === 'server') origins.add(new URL(preview.source).origin);
      }
    }
    while (origins.size > 32) origins.delete(origins.values().next().value!);
    this.origins.set(threadId, origins);
    while (this.origins.size > 1000) this.origins.delete(this.origins.keys().next().value!);
  }
  target(threadId: string, origin: string, path: string): URL {
    const local = localPreviewUrl(origin);
    if (!local || new URL(local).origin !== origin || !this.origins.get(threadId)?.has(origin)) throw new Error('preview-not-in-thread');
    if (!path.startsWith('/') || path.startsWith('//') || /[\x00-\x20\\]/.test(path)) throw new Error('invalid-preview-path');
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('invalid-preview-path');
    // Avoid DNS resolution even for localhost. The destination always remains loopback.
    url.hostname = url.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    return url;
  }
}

/** Preview traffic bypasses command queues; cancellation follows the device socket lifecycle. */
export class PreviewAgent {
  private operations = new Map<string, () => void>();
  private sockets = new Map<string, WebSocket>();
  constructor(readonly registry: PreviewRegistry, private send: (message: PreviewResponse) => boolean, private allowed: (threadId: string) => boolean) {}
  close() { for (const cancel of this.operations.values()) cancel(); this.operations.clear(); this.sockets.clear(); }
  handle(value: unknown): boolean {
    const http = previewRequestSchema.safeParse(value);
    const socket = http.success ? null : previewSocketSchema.safeParse(value);
    if (!http.success && !socket?.success) return false;
    const message = http.success ? http.data : socket!.data!;
    const emit = (event: PreviewResponse['event']) => {
      if (!this.send({ type: 'device.preview', requestId: message.requestId, event })) this.operations.get(message.requestId)?.();
    };
    if (message.type === 'preview.cancel') { this.operations.get(message.requestId)?.(); return true; }
    if (message.type === 'preview.ws.data') {
      const ws = this.sockets.get(message.requestId);
      if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(Buffer.from(message.data, 'base64'), { binary: message.binary });
      else this.operations.get(message.requestId)?.();
      return true;
    }
    let url: URL;
    try {
      if (!this.allowed(message.threadId) || this.operations.size >= 32) throw new Error('preview-unavailable');
      url = this.registry.target(message.threadId, message.origin, message.path);
    } catch (error) { emit({ type: 'error', code: error instanceof Error ? error.message : 'preview-unavailable' }); return true; }
    if (message.type === 'preview.ws.open') {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url, message.protocols, { maxPayload: PREVIEW_CHUNK_BYTES, perMessageDeflate: false, headers: { origin: message.origin, host: new URL(message.origin).host } });
      this.sockets.set(message.requestId, ws);
      this.operations.set(message.requestId, () => { ws.terminate(); this.operations.delete(message.requestId); this.sockets.delete(message.requestId); });
      ws.on('open', () => emit({ type: 'ws.open', protocol: ws.protocol }));
      ws.on('message', (data, binary) => emit({ type: 'ws.data', data: Buffer.from(data as Buffer).toString('base64'), binary }));
      ws.on('error', () => emit({ type: 'error', code: 'preview-websocket-failed' }));
      ws.on('close', () => { this.operations.delete(message.requestId); this.sockets.delete(message.requestId); emit({ type: 'ws.close' }); });
      return true;
    }
    const headers: Record<string, string> = { host: new URL(message.origin).host, 'accept-encoding': 'identity' };
    for (const key of ['accept', 'content-type', 'cookie', 'if-none-match', 'if-modified-since', 'range']) if (message.headers[key]) headers[key] = message.headers[key];
    // The original loopback origin is required by local CSRF and HMR checks.
    headers.origin = message.origin;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: message.method, headers, timeout: 20000 }, response => {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) result[key] = Array.isArray(value) ? value.join(key === 'set-cookie' ? '\n' : ', ') : value;
      emit({ type: 'headers', status: response.statusCode ?? 502, headers: result });
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PREVIEW_RESPONSE_BYTES) { request.destroy(new Error('preview-response-too-large')); return; }
        for (let at = 0; at < chunk.length; at += PREVIEW_CHUNK_BYTES) emit({ type: 'data', data: chunk.subarray(at, at + PREVIEW_CHUNK_BYTES).toString('base64') });
      });
      response.on('end', () => { this.operations.delete(message.requestId); emit({ type: 'end' }); });
    });
    this.operations.set(message.requestId, () => { request.destroy(); this.operations.delete(message.requestId); });
    request.on('timeout', () => request.destroy(new Error('preview-timeout')));
    request.on('error', error => { this.operations.delete(message.requestId); emit({ type: 'error', code: error.message === 'preview-response-too-large' ? error.message : 'preview-unavailable' }); });
    if (message.body) request.write(Buffer.from(message.body, 'base64'));
    request.end(); return true;
  }
}
