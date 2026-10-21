import { createHash } from 'node:crypto';
import type { PermissionMode, PermissionSettings } from '../../protocol/src/index.js';

type Value = Record<string, unknown>;
const object = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {};
function canonical(v: unknown): unknown {
  return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
}
export function permissionSettings(value: unknown): PermissionSettings | undefined {
  const s = object(value), sandbox = object(s.sandboxPolicy).type;
  if (typeof sandbox !== 'string' || s.approvalPolicy == null || typeof s.approvalsReviewer !== 'string') return;
  const approval = typeof s.approvalPolicy === 'string' ? s.approvalPolicy : 'custom';
  const reviewer = s.approvalsReviewer;
  const mode = sandbox === 'dangerFullAccess' && approval === 'never' && reviewer === 'user' ? 'full-access'
    : sandbox === 'workspaceWrite' && approval === 'on-request' ? reviewer === 'user' ? 'ask' : ['auto_review', 'guardian_subagent'].includes(reviewer) ? 'auto-review' : 'custom'
    : sandbox === 'readOnly' && approval === 'on-request' && reviewer === 'user' ? 'read-only' : 'custom';
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({sandbox: s.sandboxPolicy, approval: s.approvalPolicy, reviewer, profile: s.activePermissionProfile ?? null, roots: s.runtimeWorkspaceRoots ?? null}))).digest('hex');
  return { mode, sandbox, approval, reviewer, fingerprint };
}
export function permissionPreset(mode: PermissionMode, roots: string[]): Value {
  const full = mode === 'full-access', readonly = mode === 'read-only';
  return {
    approvalPolicy: full ? 'never' : 'on-request', approvalsReviewer: mode === 'auto-review' ? 'guardian_subagent' : 'user',
    activePermissionProfile: {id: full ? ':danger-full-access' : readonly ? ':read-only' : ':workspace', extends: null},
    sandboxPolicy: full ? {type: 'dangerFullAccess'} : readonly ? {type: 'readOnly', networkAccess: false} : {type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false},
    runtimeWorkspaceRoots: roots,
  };
}
export function savedPermissionSettings(s: {sandbox: string; sandboxPolicy: Value; approvalPolicy: unknown; approvalsReviewer: unknown; roots: string[]}): Value {
  return { approvalPolicy: s.approvalPolicy, approvalsReviewer: s.approvalsReviewer, runtimeWorkspaceRoots: s.roots,
    sandboxPolicy: s.sandbox === 'danger-full-access' ? {type: 'dangerFullAccess'} : s.sandbox === 'read-only' ? {type: 'readOnly', networkAccess: s.sandboxPolicy.network_access ?? false} : {type: 'workspaceWrite', writableRoots: s.sandboxPolicy.writable_roots ?? [], networkAccess: s.sandboxPolicy.network_access ?? false, excludeSlashTmp: s.sandboxPolicy.exclude_slash_tmp ?? false, excludeTmpdirEnvVar: s.sandboxPolicy.exclude_tmpdir_env_var ?? false} };
}
