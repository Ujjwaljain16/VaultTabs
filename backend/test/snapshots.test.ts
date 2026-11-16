import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SnapshotHistoryResponse, SnapshotsResponse, SnapshotWithDevice } from '@vaulttabs/shared';
import { decryptLabel, decryptSnapshot, encryptLabel, encryptSnapshot } from '@vaulttabs/shared/crypto';
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
  ctx = await setup();
});
afterAll(async () => teardown(ctx));

const TABS = [
  { id: 1, url: 'https://example.com/a', title: 'A', windowId: 1, index: 0, active: true, pinned: false },
];

async function snapshotBody(user: TestUser, deviceId: string, capturedAt: Date) {
  const enc = await encryptSnapshot(TABS, user.masterKey, { userId: user.userId, deviceId, capturedAt });
  return { device_id: deviceId, captured_at: capturedAt.toISOString(), ...enc };
}

async function upload(user: TestUser, deviceId: string, capturedAt: Date): Promise<string> {
  const res = await api(ctx.server, 'POST', '/snapshots', {
    token: user.token,
    body: await snapshotBody(user, deviceId, capturedAt),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ snapshot_id: string }>().snapshot_id;
}

describe('upload validation', () => {
  it('rejects enc_version 1 / missing with an update message', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const body = await snapshotBody(user, device, new Date());
    for (const enc_version of [1, undefined]) {
      const res = await api(ctx.server, 'POST', '/snapshots', {
        token: user.token,
        body: { ...body, enc_version },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'unsupported_enc_version',
        message: expect.stringMatching(/update/i),
      });
    }
  });

  it('rejects future timestamps, bad base64, oversize blobs and foreign devices', async () => {
    const user = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const otherDevice = await registerDevice(ctx.server, other.token);
    const body = await snapshotBody(user, device, new Date());

    const future = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, captured_at: new Date(Date.now() + 11 * 60_000).toISOString() },
    });
    expect(future.json()).toMatchObject({ code: 'captured_at_in_future' });

    const badIv = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, iv: 'short' },
    });
    expect(badIv.statusCode).toBe(400);
    const notB64 = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, encrypted_blob: 'not base64!' },
    });
    expect(notB64.statusCode).toBe(400);
    const huge = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, encrypted_blob: 'A'.repeat(2_000_004) },
    });
    expect(huge.statusCode).toBe(400);

    const foreign = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, device_id: otherDevice },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'device_not_found' });

    const ok = await api(ctx.server, 'POST', '/snapshots', {
      token: user.token,
      body: { ...body, legacy_extra_field: 1 },
    });
    expect(ok.statusCode).toBe(201);
    const [row] = await ctx.sql<{ size_bytes: number; enc_version: number }[]>`
      SELECT size_bytes, enc_version FROM snapshots WHERE id = ${ok.json<{ snapshot_id: string }>().snapshot_id}`;
    expect(row).toEqual({ size_bytes: body.encrypted_blob.length, enc_version: 2 });
  });
});

describe('upload rate limit', () => {
  it('limits uploads per user', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const body = { ...(await snapshotBody(user, device, new Date())), enc_version: 1 };
    const statuses: number[] = [];
    // Different IPs: the limit is keyed on the user, not the address.
    for (let i = 0; i < 61; i++)
      statuses.push((await api(ctx.server, 'POST', '/snapshots', { token: user.token, body })).statusCode);
    expect(statuses.slice(0, 60).every(s => s === 400)).toBe(true);
    expect(statuses[60]).toBe(429);
    const other = await registerUser(ctx.server);
    const otherDevice = await registerDevice(ctx.server, other.token);
    expect(await upload(other, otherDevice, new Date())).toEqual(expect.any(String));
  });
});

describe('reading snapshots', () => {
  it('latest returns the newest per device with device info, decryptable with its context', async () => {
    const user = await registerUser(ctx.server);
    const d1 = await registerDevice(ctx.server, user.token, 'one');
    const d2 = await registerDevice(ctx.server, user.token, 'two');
    const base = Date.now() - 100_000;
    await upload(user, d1, new Date(base));
    const newest = await upload(user, d1, new Date(base + 1000));
    await upload(user, d2, new Date(base + 500));

    const res = (
      await api(ctx.server, 'GET', '/snapshots/latest', { token: user.token })
    ).json<SnapshotsResponse>();
    expect(res.snapshots).toHaveLength(2);
    const s1 = res.snapshots.find(s => s.device_id === d1)!;
    expect(s1).toMatchObject({
      id: newest,
      device_name: 'one',
      enc_version: 2,
      pinned: false,
      label_enc: null,
      user_id: user.userId,
    });
    expect(s1.last_seen).toBeTruthy();
    const tabs = await decryptSnapshot(s1.encrypted_blob, s1.iv, user.masterKey, s1.enc_version, {
      userId: user.userId,
      deviceId: s1.device_id,
      capturedAt: s1.captured_at,
    });
    expect(tabs[0]!.url).toBe('https://example.com/a');
  });

  it('pages history with the before cursor', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const other = await registerDevice(ctx.server, user.token);
    const base = Date.now() - 1_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await upload(user, device, new Date(base + i * 1000)));
    await upload(user, other, new Date(base + 99_000));
    const newestFirst = [...ids].reverse();

    const page1 = (
      await api(ctx.server, 'GET', `/snapshots/history?device_id=${device}&limit=2`, { token: user.token })
    ).json<SnapshotHistoryResponse>();
    expect(page1.snapshots.map(s => s.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.next_before).toBe(new Date(base + 3000).toISOString());

    const page2 = (
      await api(
        ctx.server,
        'GET',
        `/snapshots/history?device_id=${device}&limit=2&before=${encodeURIComponent(page1.next_before!)}`,
        { token: user.token },
      )
    ).json<SnapshotHistoryResponse>();
    expect(page2.snapshots.map(s => s.id)).toEqual(newestFirst.slice(2, 4));

    const page3 = (
      await api(
        ctx.server,
        'GET',
        `/snapshots/history?device_id=${device}&limit=2&before=${encodeURIComponent(page2.next_before!)}`,
        { token: user.token },
      )
    ).json<SnapshotHistoryResponse>();
    expect(page3.snapshots.map(s => s.id)).toEqual(newestFirst.slice(4));
    expect(page3.next_before).toBeNull();

    const all = (
      await api(ctx.server, 'GET', '/snapshots/history?limit=500', { token: user.token })
    ).json<SnapshotHistoryResponse>();
    expect(all.snapshots).toHaveLength(6);

    const stranger = await registerUser(ctx.server);
    expect(
      (await api(ctx.server, 'GET', `/snapshots/history?device_id=${device}`, { token: stranger.token }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(ctx.server, 'GET', '/snapshots/history?device_id=nope', { token: user.token })).statusCode,
    ).toBe(400);
  });
});

describe('saved sessions', () => {
  it('pins, labels, unpins and survives pruning', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    await api(ctx.server, 'PATCH', '/account/retention', { token: user.token, body: { retention: 2 } });
    const base = Date.now() - 500_000;
    const first = await upload(user, device, new Date(base));

    const label = await encryptLabel('Research tabs', user.masterKey, user.userId, first);
    const unpinnedLabel = await api(ctx.server, 'PATCH', `/snapshots/${first}`, {
      token: user.token,
      body: label,
    });
    expect(unpinnedLabel.json()).toMatchObject({ code: 'not_saved' });
    const halfLabel = await api(ctx.server, 'PATCH', `/snapshots/${first}`, {
      token: user.token,
      body: { label_enc: label.label_enc },
    });
    expect(halfLabel.statusCode).toBe(400);

    const pinned = await api(ctx.server, 'PATCH', `/snapshots/${first}`, {
      token: user.token,
      body: { pinned: true, ...label },
    });
    expect(pinned.statusCode).toBe(200);
    const snap = pinned.json<{ snapshot: SnapshotWithDevice }>().snapshot;
    expect(snap).toMatchObject({
      id: first,
      pinned: true,
      label_enc: label.label_enc,
      label_iv: label.label_iv,
      device_name: 'Test browser',
    });
    expect(await decryptLabel(snap.label_enc!, snap.label_iv!, user.masterKey, user.userId, first)).toBe(
      'Research tabs',
    );

    for (let i = 1; i <= 4; i++) await upload(user, device, new Date(base + i * 1000));
    const remaining = await ctx.sql<
      { id: string; pinned: boolean }[]
    >`SELECT id, pinned FROM snapshots WHERE user_id = ${user.userId}`;
    expect(remaining).toHaveLength(3); // pinned + 2 newest
    expect(remaining.some(r => r.id === first && r.pinned)).toBe(true);

    const saved = (
      await api(ctx.server, 'GET', '/snapshots/saved', { token: user.token })
    ).json<SnapshotsResponse>();
    expect(saved.snapshots.map(s => s.id)).toEqual([first]);

    const unpinned = await api(ctx.server, 'PATCH', `/snapshots/${first}`, {
      token: user.token,
      body: { pinned: false },
    });
    expect(unpinned.json<{ snapshot: SnapshotWithDevice }>().snapshot).toMatchObject({
      pinned: false,
      label_enc: null,
      label_iv: null,
    });

    const got = await api(ctx.server, 'GET', `/snapshots/${first}`, { token: user.token });
    expect(got.json<{ snapshot: SnapshotWithDevice }>().snapshot.id).toBe(first);
    expect((await api(ctx.server, 'DELETE', `/snapshots/${first}`, { token: user.token })).statusCode).toBe(
      200,
    );
    expect((await api(ctx.server, 'GET', `/snapshots/${first}`, { token: user.token })).statusCode).toBe(404);
  });

  it('enforces the saved-session limit', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const candidate = await upload(user, device, new Date(Date.now() - 1000));
    await ctx.sql`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob, enc_version, pinned, size_bytes)
      SELECT ${user.userId}, ${device}, NOW() - make_interval(secs => g), 'AAAAAAAAAAAAAAAA', 'AAAA', 2, true, 4
      FROM generate_series(1, 100) AS g`;
    const res = await api(ctx.server, 'PATCH', `/snapshots/${candidate}`, {
      token: user.token,
      body: { pinned: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'saved_limit' });
    // Re-pinning an already pinned one is fine.
    const [pinned] = await ctx.sql<
      { id: string }[]
    >`SELECT id FROM snapshots WHERE user_id = ${user.userId} AND pinned LIMIT 1`;
    expect(
      (
        await api(ctx.server, 'PATCH', `/snapshots/${pinned!.id}`, {
          token: user.token,
          body: { pinned: true },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("denies access to another user's snapshots by id", async () => {
    const alice = await registerUser(ctx.server);
    const bob = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, alice.token);
    const id = await upload(alice, device, new Date(Date.now() - 1000));
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { pinned: true }],
      ['DELETE', undefined],
    ] as const) {
      const res = await api(ctx.server, method, `/snapshots/${id}`, { token: bob.token, body });
      expect(res.statusCode, method).toBe(404);
    }
    for (const bad of ['not-a-uuid', NIL_UUID]) {
      expect((await api(ctx.server, 'GET', `/snapshots/${bad}`, { token: alice.token })).statusCode).toBe(
        404,
      );
    }
    const [row] = await ctx.sql<{ pinned: boolean }[]>`SELECT pinned FROM snapshots WHERE id = ${id}`;
    expect(row!.pinned).toBe(false);
  });
});
