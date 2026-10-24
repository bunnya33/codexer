import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRelay, RelayStore, hash } from './go-relay.js';
import { testAccount } from './account-helpers.js';
import { WsPeer } from './helpers.js';
import { NEVER_EXPIRES_AT, MAX_AGENT_SESSION_DAYS } from '../packages/shared/src/session-policy.js';
import { agentLoginValid } from '../apps/pc-agent/src/auth.js';
import { writeSecret } from '../packages/shared/src/secrets.js';

const day = 86400000;
const path = '/v1/admin/auth-settings';

it('allows only administrators to configure PC durations and validates partial policy updates', async () => {
  const store = await RelayStore.open(), admin = await testAccount(store, 'admin', 'admin'), user = await testAccount(store);
  const app = await createRelay({ store });
  try {
    const update = (payload: unknown, headers = admin.headers) => app.inject({ method: 'PUT', url: path, headers, payload });
    expect((await app.inject({ url: path, headers: admin.headers })).json()).toEqual({ idleTimeoutMinutes: 10080, agentSessionDays: 7 });
    expect((await update({ agentSessionDays: 0 }, user.headers)).statusCode).toBe(403);
    for (const agentSessionDays of [-1, 1.5, MAX_AGENT_SESSION_DAYS + 1, '30', null, true]) {
      expect((await update({ agentSessionDays })).statusCode).toBe(400);
    }
    for (const payload of [{}, { other: 0 }, { agentSessionDays: 0, other: 0 }, { idleTimeoutMinutes: 0, agentSessionDays: 0 }]) {
      expect((await update(payload)).statusCode).toBe(400);
    }
    expect((await update({ agentSessionDays: 90 })).json()).toEqual({ idleTimeoutMinutes: 10080, agentSessionDays: 90 });
    expect((await update({ idleTimeoutMinutes: 60 })).json()).toEqual({ idleTimeoutMinutes: 60, agentSessionDays: 90 });
    expect((await update({ idleTimeoutMinutes: 120, agentSessionDays: MAX_AGENT_SESSION_DAYS })).statusCode).toBe(200);
  } finally { await app.close(); }
});

it('extends two active PC logins from their login times, leaves browser logins alone and never revives expired tokens', async () => {
  const store = await RelayStore.open(), admin = await testAccount(store, 'admin', 'admin'), user = await testAccount(store);
  const devices = await Promise.all(['one', 'two', 'expired'].map(name => store.registerAgent(user.id, randomUUID(), name, 'win32')));
  const sessions = await Promise.all(devices.map(id => store.createSession(user.id, id)));
  const [first, second, expired] = sessions;
  const browserExpiry = (await store.sessionPrincipal(user.session))!.expiresAt;
  await store.query('UPDATE sessions SET expires_at=$2 WHERE hash=$1', [hash(expired!.session), Date.now() - 1]);
  const app = await createRelay({ store });
  try {
    expect((await app.inject({ method: 'PUT', url: path, headers: admin.headers, payload: { agentSessionDays: 90 } })).statusCode).toBe(200);
    for (const [index, session] of [first!, second!].entries()) {
      const principal = (await store.sessionPrincipal(session.session, devices[index]))!;
      expect(principal.expiresAt).toBe(session.expiresAt + 83 * day);
      const response = await app.inject({ url: `/v1/agent/${devices[index]}/session`, headers: { authorization: `Bearer ${session.session}` } });
      expect(response.json()).toEqual({ active: true, expiresAt: principal.expiresAt });
    }
    expect(await store.sessionPrincipal(expired!.session, devices[2])).toBeNull();
    expect((await store.sessionPrincipal(user.session))!.expiresAt).toBe(browserExpiry);
    await app.inject({ method: 'PUT', url: path, headers: admin.headers, payload: { agentSessionDays: 0 } });
    expect((await store.sessionPrincipal(first!.session, devices[0]))!.expiresAt).toBe(NEVER_EXPIRES_AT);
    expect(await store.sessionPrincipal(expired!.session, devices[2])).toBeNull();
    const fresh = await store.createSession(user.id, devices[2]);
    expect(fresh.expiresAt).toBe(NEVER_EXPIRES_AT);
    const logout = (deviceId: string) => app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${first!.session}`, 'x-device-id': deviceId } });
    expect((await logout(devices[1]!)).statusCode).toBe(401);
    expect((await logout(devices[0]!)).statusCode).toBe(200);
    expect(await store.sessionPrincipal(first!.session, devices[0])).toBeNull();
    await store.resetPassword(user.id, 'changed-test-password');
    expect(await store.sessionPrincipal(second!.session, devices[1])).toBeNull();
    expect(await store.sessionPrincipal(fresh.session, devices[2])).toBeNull();
  } finally { await app.close(); }
});

it('expires connected PCs when switching from never to a shorter duration without reviving them later', async () => {
  const store = await RelayStore.open(), user = await testAccount(store);
  const device = await store.registerAgent(user.id, randomUUID(), 'PC', 'win32');
  await store.setAuthSettings({ agentSessionDays: 0 });
  const session = await store.createSession(user.id, device);
  await store.query('UPDATE sessions SET last_active_at=$2 WHERE hash=$1', [hash(session.session), Date.now() - 8 * day]);
  const app = await createRelay({ store, heartbeatMs: 20 });
  let peer: WsPeer | undefined;
  try {
    const base = await app.listen();
    peer = await WsPeer.open(base.replace('http:', 'ws:') + '/v1/ws/device', { authorization: `Bearer ${session.session}`, 'x-device-id': device });
    await peer.wait(message => message.type === 'device.welcome');
    await store.setAuthSettings({ agentSessionDays: 7 });
    expect(await peer.closed).toBe(4003);
    await store.setAuthSettings({ agentSessionDays: 0 });
    expect(await store.sessionPrincipal(session.session, device)).toBeNull();
  } finally { peer?.socket.terminate(); await app.close(); }
});

it('persists nonexpiring PC policy and existing tokens across server restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-agent-policy-'));
  let store: RelayStore | undefined;
  try {
    store = await RelayStore.open(undefined, directory);
    const user = await testAccount(store), device = await store.registerAgent(user.id, randomUUID(), 'PC', 'win32');
    await store.setAuthSettings({ agentSessionDays: 0 });
    const session = await store.createSession(user.id, device);
    await store.close(); store = await RelayStore.open(undefined, directory);
    expect(await store.authSettings()).toEqual({ idleTimeoutMinutes: 10080, agentSessionDays: 0 });
    expect((await store.sessionPrincipal(session.session, device))!.expiresAt).toBe(NEVER_EXPIRES_AT);
  } finally { await store?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('checks CLI credentials against the server after an administrator extends their locally cached expiry', async () => {
  const store = await RelayStore.open(), user = await testAccount(store);
  const device = await store.registerAgent(user.id, randomUUID(), 'PC', 'win32');
  await store.setAuthSettings({ agentSessionDays: 0 });
  const session = await store.createSession(user.id, device), app = await createRelay({ store });
  const directory = await mkdtemp(join(tmpdir(), 'agent-cached-expiry-'));
  try {
    const relayUrl = await app.listen(), file = join(directory, 'credentials.secret');
    await writeSecret(file, { relayUrl, deviceId: device, session: session.session, expiresAt: Date.now() - 1, username: 'fixture', installationId: randomUUID() });
    expect(await agentLoginValid(file)).toBe(true);
    await store.resetPassword(user.id, 'changed-test-password');
    expect(await agentLoginValid(file)).toBe(false);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
