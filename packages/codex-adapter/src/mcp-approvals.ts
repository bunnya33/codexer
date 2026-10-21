import type { RemoteApproval } from '../../protocol/src/index.js';

type Value = Record<string, unknown>;
const object = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {};
export function mcpApproval(params: Value): RemoteApproval | undefined {
  if (params.mode !== 'form') return;
  const schema = object(params.requestedSchema), meta = object(params._meta);
  // These cards approve access, not arbitrary forms, login challenges or tool input.
  if (schema.type !== 'object' || !schema.properties || Object.keys(object(schema.properties)).length || Array.isArray(schema.required) && schema.required.length) return;
  if (meta.approveDisabled === true || meta.executionBound === true || Object.keys(meta).some(k => k.startsWith('openai/'))) return;
  const persist = Array.isArray(meta.persist) ? meta.persist : meta.persist == null ? [] : [meta.persist];
  if (persist.some(v => v !== 'session' && v !== 'always')) return;
  const tool = object(meta.tool_params), connector = typeof meta.connector_id === 'string' ? meta.connector_id.toLowerCase().replace(/[^a-z0-9]+/g, '-') : '';
  const scopes: RemoteApproval['scopes'] = ['once', ...persist.filter((v): v is 'session' | 'always' => v === 'session' || v === 'always')];
  const message = typeof meta.subtitle === 'string' ? meta.subtitle : typeof params.message === 'string' ? params.message : undefined;
  if (message && message.length > 8192) return;
  if (['browser', 'browser-use'].includes(String(params.serverName)) || ['browser', 'browser-use'].includes(connector)) {
    if (meta.codex_approval_kind != null && meta.codex_approval_kind !== 'mcp_tool_call') return;
    const target = meta.origin ?? tool.origin ?? tool.url;
    if (typeof target !== 'string' || target.length > 2048) return;
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') return;
      return {kind: 'browser', target: url.origin, scopes: [...new Set(scopes)], ...(message ? {message} : {})};
    } catch { return; }
  }
  if (meta.codex_approval_kind !== 'mcp_tool_call' || !(connector === 'computer-use' || connector.startsWith('computer-use-')) || !persist.length) return;
  if (typeof tool.app !== 'string' || !tool.app.trim() || tool.app.length > 1000) return;
  const display = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.map(object).find(v => v.name === 'app')?.value : undefined;
  if (typeof display === 'string' && display.length > 1000) return;
  return {kind: 'computer', target: typeof display === 'string' && display.trim() ? display : tool.app, scopes: [...new Set(scopes)], ...(message ? {message} : {}), ...(meta.riskLevel === 'high' ? {elevatedRisk: true} : {})};
}
export function mcpApprovalResponse(params: Value, decision: 'accept' | 'decline' | 'cancel', scope: 'once' | 'session' | 'always'): Value {
  const approval = mcpApproval(params);
  if (!approval || !approval.scopes.includes(scope) || decision !== 'accept' && scope !== 'once') throw new Error('approval-scope-not-available');
  return {action: decision, content: decision === 'accept' ? {} : null, _meta: decision === 'accept' && scope !== 'once' ? {persist: scope} : null};
}
