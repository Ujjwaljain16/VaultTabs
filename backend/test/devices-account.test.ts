import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountDevicesResponse, AccountInfoResponse, Device, DevicesResponse } from '@vaulttabs/shared';
import { encryptSnapshot } from '@vaulttabs/shared/crypto';
import {
  api,
  NIL_UUID,
  registerDevice,
  registerUser,
  setup,
  teardown,
  type TestContext,
  type TestUser,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup({ MAX_DEVICES_PER_USER: '3' });
});
afterAll(async () => teardown(ctx));

async function upload(user: TestUser, deviceId: string, capturedAt: Date) {
  const enc = await encryptSnapshot(
    [{ id: 1, url: 'https://example.com/', title: 'x', windowId: 1, index: 0, active: true, pinned: false }],
    user.masterKey,
    { userId: user.userId, deviceId, capturedAt },
  );
  const res = await api(ctx.server, 'POST', '/snapshots', {
    token: user.token,
    body: { device_id: deviceId, captured_at: capturedAt.toISOString(), ...enc },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ snapshot_id: string }>().snapshot_id;
}

describe('devices', () => {
  it('re-registers own device ids and ignores unknown fields', async () => {
    const user = await registerUser(ctx.server);
    const first = await api(ctx.server, 'POST', '/devices/register', {
      token: user.token,
      body: { device_name: 'Chrome', fingerprint: 'legacy-field' },
    });
    expect(first.statusCode).toBe(201);
    const device = first.json<{ device: Device }>().device;
    expect(device).toMatchObject({ user_id: user.userId, device_name: 'Chrome' });
    expect(device).not.toHaveProperty('fingerprint');

    const again = await api(ctx.server, 'POST', '/devices/register', {
      token: user.token,
      body: { device_name: 'Chrome (renamed)', id: device.id },
    });
    expect(again.json<{ device: Device }>().device).toMatchObject({
      id: device.id,
      device_name: 'Chrome (renamed)',
    });

    // A non-existent id is not adopted: a new random id is issued.
    const fresh = await api(ctx.server, 'POST', '/devices/register', {
      token: user.token,
      body: { device_name: 'Firefox', id: NIL_UUID },
    });
    expect(fresh.json<{ device: Device }>().device.id).not.toBe(NIL_UUID);

    const list = (await api(ctx.server, 'GET', '/devices', { token: user.token })).json<DevicesResponse>();
    expect(list.devices).toHaveLength(2);
  });

  it("cannot take over or touch another user's device", async () => {
    const alice = await registerUser(ctx.server);
    const mallory = await registerUser(ctx.server);
    const aliceDevice = await registerDevice(ctx.server, alice.token, "Alice's laptop");

    const takeover = await api(ctx.server, 'POST', '/devices/register', {
      token: mallory.token,
      body: { device_name: 'pwned', id: aliceDevice },
    });
    expect(takeover.statusCode).toBe(201);
    const malloryDevice = takeover.json<{ device: Device }>().device;
    expect(malloryDevice.id).not.toBe(aliceDevice);
    expect(malloryDevice.user_id).toBe(mallory.userId);

    const [row] = await ctx.sql<{ user_id: string; device_name: string }[]>`
      SELECT user_id, device_name FROM devices WHERE id = ${aliceDevice}`;
    expect(row).toEqual({ user_id: alice.userId, device_name: "Alice's laptop" });

    for (const [method, url, body] of [
      ['PATCH', `/devices/${aliceDevice}/heartbeat`, undefined],
      ['DELETE', `/devices/${aliceDevice}`, undefined],
      ['PATCH', `/account/devices/${aliceDevice}`, { device_name: 'x' }],
      ['DELETE', `/account/devices/${aliceDevice}`, undefined],
    ] as const) {
      const res = await api(ctx.server, method, url, { token: mallory.token, body });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(
      (await api(ctx.server, 'PATCH', `/devices/${aliceDevice}/heartbeat`, { token: alice.token })).json(),
    ).toEqual({ ok: true });
    // Malformed ids are a 404 too, never a 500.
    expect(
      (await api(ctx.server, 'PATCH', '/devices/not-a-uuid/heartbeat', { token: alice.token })).statusCode,
    ).toBe(404);
  });

  it('enforces MAX_DEVICES_PER_USER', async () => {
    const user = await registerUser(ctx.server);
    for (let i = 0; i < 3; i++) await registerDevice(ctx.server, user.token, `d${i}`);
    const res = await api(ctx.server, 'POST', '/devices/register', {
      token: user.token,
      body: { device_name: 'one too many' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'device_limit' });
  });

  it('renames and deletes devices', async () => {
    const user = await registerUser(ctx.server);
    const id = await registerDevice(ctx.server, user.token);
    const renamed = await api(ctx.server, 'PATCH', `/account/devices/${id}`, {
      token: user.token,
      body: { device_name: '  Work PC ' },
    });
    expect(renamed.json<{ device: Device }>().device.device_name).toBe('Work PC');
    expect(
      (await api(ctx.server, 'DELETE', `/account/devices/${id}`, { token: user.token })).statusCode,
    ).toBe(200);
    expect((await api(ctx.server, 'DELETE', `/devices/${id}`, { token: user.token })).statusCode).toBe(404);
  });
});

describe('account', () => {
  it('reports correct stats (no cross-join inflation)', async () => {
    const user = await registerUser(ctx.server);
    const empty = (
      await api(ctx.server, 'GET', '/account', { token: user.token })
    ).json<AccountInfoResponse>();
    expect(empty.stats).toEqual({
      device_count: 0,
      snapshot_count: 0,
      saved_count: 0,
      storage_bytes: 0,
      last_sync_at: null,
    });
    expect(empty.account).toMatchObject({
      id: user.userId,
      email: user.email,
      has_recovery_key: true,
      kdf_version: 2,
    });

    const d1 = await registerDevice(ctx.server, user.token, 'one');
    const d2 = await registerDevice(ctx.server, user.token, 'two');
    await registerDevice(ctx.server, user.token, 'three (no snapshots)');
    const base = Date.now() - 60_000;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await upload(user, d1, new Date(base + i * 1000)));
    ids.push(await upload(user, d2, new Date(base + 10_000)));
    await api(ctx.server, 'PATCH', `/snapshots/${ids[0]}`, { token: user.token, body: { pinned: true } });

    const info = (
      await api(ctx.server, 'GET', '/account', { token: user.token })
    ).json<AccountInfoResponse>();
    const [bytes] = await ctx.sql<
      { n: number }[]
    >`SELECT SUM(octet_length(encrypted_blob))::int AS n FROM snapshots WHERE user_id = ${user.userId}`;
    expect(info.stats).toMatchObject({
      device_count: 3,
      snapshot_count: 4,
      saved_count: 1,
      storage_bytes: bytes!.n,
    });
    expect(new Date(info.stats.last_sync_at!).getTime()).toBe(base + 10_000);

    const devices = (
      await api(ctx.server, 'GET', '/account/devices', { token: user.token })
    ).json<AccountDevicesResponse>();
    const byName = Object.fromEntries(devices.devices.map(d => [d.device_name, d]));
    expect(byName['one']).toMatchObject({ snapshot_count: 3, user_id: user.userId });
    expect(byName['two']).toMatchObject({ snapshot_count: 1 });
    expect(byName['three (no snapshots)']).toMatchObject({ snapshot_count: 0, last_snapshot_at: null });
  });

  it('validates and applies retention immediately, keeping pinned snapshots', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const base = Date.now() - 600_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await upload(user, device, new Date(base + i * 1000)));
    // Pin the oldest.
    await api(ctx.server, 'PATCH', `/snapshots/${ids[0]}`, { token: user.token, body: { pinned: true } });

    for (const retention of [0, 501, 2.5, '10']) {
      const bad = await api(ctx.server, 'PATCH', '/account/retention', {
        token: user.token,
        body: { retention },
      });
      expect(bad.statusCode, String(retention)).toBe(400);
    }
    const res = await api(ctx.server, 'PATCH', '/account/retention', {
      token: user.token,
      body: { retention: 2 },
    });
    expect(res.json()).toEqual({ retention: 2 });

    const rows = await ctx.sql<
      { id: string }[]
    >`SELECT id FROM snapshots WHERE user_id = ${user.userId} ORDER BY captured_at`;
    expect(rows.map(r => r.id)).toEqual([ids[0], ids[3], ids[4]]);
    const info = (
      await api(ctx.server, 'GET', '/account', { token: user.token })
    ).json<AccountInfoResponse>();
    expect(info.account.snapshot_retention).toBe(2);
  });
});
