import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateRestoreResponse, PendingRestoreResponse, RestoreStatusResponse } from '@vaulttabs/shared';
import { decryptRestorePayload, encryptRestorePayload, encryptSnapshot } from '@vaulttabs/shared/crypto';
import { buildServer } from '../src/app.js';
import {
  api,
  NIL_UUID,
  registerDevice,
  registerUser,
  setup,
  teardown,
  testConfig,
  type TestContext,
  type TestUser,
} from './helpers.js';

let ctx: TestContext;
let baseUrl: string;
beforeAll(async () => {
  ctx = await setup();
  await ctx.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(ctx.server.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => teardown(ctx));

async function upload(user: TestUser, deviceId: string): Promise<string> {
  const capturedAt = new Date(Date.now() - 1000);
  const enc = await encryptSnapshot(
    [{ id: 1, url: 'https://example.com/', title: 'x', windowId: 1, index: 0, active: true, pinned: false }],
    user.masterKey,
    { userId: user.userId, deviceId, capturedAt },
  );
  const res = await api(ctx.server, 'POST', '/snapshots', {
    token: user.token,
    body: { device_id: deviceId, captured_at: capturedAt.toISOString(), ...enc },
  });
  return res.json<{ snapshot_id: string }>().snapshot_id;
}

describe('restore requests', () => {
  it('creates snapshot and payload requests, exposes pending, completes and reports status', async () => {
    const user = await registerUser(ctx.server);
    const source = await registerDevice(ctx.server, user.token, 'source');
    const target = await registerDevice(ctx.server, user.token, 'target');
    const snapshotId = await upload(user, source);

    const none = await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token });
    expect(none.json()).toEqual({ pending: false });

    const first = await api(ctx.server, 'POST', '/restore', {
      token: user.token,
      body: { target_device_id: target, snapshot_id: snapshotId },
    });
    expect(first.statusCode).toBe(201);
    const firstReq = first.json<CreateRestoreResponse>();
    expect(firstReq).toMatchObject({
      status: 'pending',
      request_id: expect.any(String),
      expires_at: expect.any(String),
    });
    // Queued for ~24 h so a closed browser still gets it when it next starts.
    const ttlHours = (new Date(firstReq.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThanOrEqual(24);

    let pending = (
      await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token })
    ).json<PendingRestoreResponse>();
    expect(pending.pending).toBe(true);
    expect(pending.request).toMatchObject({
      id: firstReq.request_id,
      target_device_id: target,
      encrypted_payload: null,
      payload_iv: null,
      snapshot: { id: snapshotId, device_id: source, enc_version: 2 },
    });

    // A second request for the same target is queued behind the first (both stay pending).
    const payload = await encryptRestorePayload(
      { urls: ['https://a.test/', 'javascript:alert(1)'] },
      user.masterKey,
      {
        userId: user.userId,
        targetDeviceId: target,
      },
    );
    const second = await api(ctx.server, 'POST', '/restore', {
      token: user.token,
      body: { target_device_id: target, ...payload },
    });
    expect(second.statusCode).toBe(201);
    const secondReq = second.json<CreateRestoreResponse>();
    const firstStatus = (
      await api(ctx.server, 'GET', `/restore/${firstReq.request_id}`, { token: user.token })
    ).json<RestoreStatusResponse>();
    expect(firstStatus.request.status).toBe('pending');

    pending = (
      await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token })
    ).json<PendingRestoreResponse>();
    // Oldest first; `request` stays the oldest for older clients.
    expect(pending.request?.id).toBe(firstReq.request_id);
    expect(pending.requests?.map(r => r.id)).toEqual([firstReq.request_id, secondReq.request_id]);
    const queued = pending.requests![1]!;
    expect(queued).toMatchObject({
      id: secondReq.request_id,
      snapshot: null,
      payload_iv: payload.payload_iv,
    });
    const decrypted = await decryptRestorePayload(
      queued.encrypted_payload!,
      queued.payload_iv!,
      user.masterKey,
      {
        userId: user.userId,
        targetDeviceId: target,
      },
    );
    expect(decrypted.urls).toEqual(['https://a.test/']);

    const done = await api(ctx.server, 'PATCH', `/restore/${secondReq.request_id}`, {
      token: user.token,
      body: { status: 'failed', error_code: 'decrypt_failed', error_msg: 'ignored free text' },
    });
    expect(done.statusCode).toBe(200);
    const status = (
      await api(ctx.server, 'GET', `/restore/${secondReq.request_id}`, { token: user.token })
    ).json<RestoreStatusResponse>();
    expect(status.request).toEqual({
      id: secondReq.request_id,
      target_device_id: target,
      snapshot_id: null,
      status: 'failed',
      error_code: 'decrypt_failed',
      created_at: expect.any(String),
      expires_at: expect.any(String),
    });
    // Only pending requests can be completed.
    const again = await api(ctx.server, 'PATCH', `/restore/${secondReq.request_id}`, {
      token: user.token,
      body: { status: 'completed' },
    });
    expect(again.statusCode).toBe(409);
    // The first request is still queued until its device opens it.
    pending = (
      await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token })
    ).json<PendingRestoreResponse>();
    expect(pending.requests?.map(r => r.id)).toEqual([firstReq.request_id]);
    await api(ctx.server, 'PATCH', `/restore/${firstReq.request_id}`, {
      token: user.token,
      body: { status: 'completed' },
    });
    expect(
      (await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token })).json(),
    ).toEqual({ pending: false });
  });

  it('keeps at most 50 queued requests per device, expiring the oldest', async () => {
    const user = await registerUser(ctx.server);
    const target = await registerDevice(ctx.server, user.token, 'target');
    const payload = await encryptRestorePayload({ urls: ['https://q.test/'] }, user.masterKey, {
      userId: user.userId,
      targetDeviceId: target,
    });
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const res = await api(ctx.server, 'POST', '/restore', {
        token: user.token,
        body: { target_device_id: target, ...payload },
      });
      ids.push(res.json<CreateRestoreResponse>().request_id);
    }
    const pending = (
      await api(ctx.server, 'GET', `/restore/pending?device_id=${target}`, { token: user.token })
    ).json<PendingRestoreResponse>();
    expect(pending.requests?.map(r => r.id)).toEqual(ids.slice(2));
    const oldest = (
      await api(ctx.server, 'GET', `/restore/${ids[0]}`, { token: user.token })
    ).json<RestoreStatusResponse>();
    expect(oldest.request.status).toBe('expired');
  });

  it('validates the request content', async () => {
    const user = await registerUser(ctx.server);
    const target = await registerDevice(ctx.server, user.token);
    const snapshotId = await upload(user, target);
    const payload = await encryptRestorePayload({ urls: ['https://a.test/'] }, user.masterKey, {
      userId: user.userId,
      targetDeviceId: target,
    });
    for (const body of [
      { target_device_id: target },
      { target_device_id: target, snapshot_id: snapshotId, ...payload },
      { target_device_id: target, encrypted_payload: payload.encrypted_payload },
      { target_device_id: target, ...payload, payload_iv: 'bad' },
      { target_device_id: target, encrypted_payload: 'A'.repeat(1_000_004), payload_iv: payload.payload_iv },
      { target_device_id: target, target_url: 'https://plaintext.test/' },
    ]) {
      const res = await api(ctx.server, 'POST', '/restore', { token: user.token, body });
      expect(res.statusCode, JSON.stringify(body).slice(0, 100)).toBe(400);
    }
  });

  it('denies cross-user access on every restore route', async () => {
    const alice = await registerUser(ctx.server);
    const bob = await registerUser(ctx.server);
    const aliceDevice = await registerDevice(ctx.server, alice.token);
    const bobDevice = await registerDevice(ctx.server, bob.token);
    const aliceSnapshot = await upload(alice, aliceDevice);
    const created = (
      await api(ctx.server, 'POST', '/restore', {
        token: alice.token,
        body: { target_device_id: aliceDevice, snapshot_id: aliceSnapshot },
      })
    ).json<CreateRestoreResponse>();

    // Bob cannot target Alice's device, nor restore Alice's snapshot onto his own device.
    expect(
      (
        await api(ctx.server, 'POST', '/restore', {
          token: bob.token,
          body: { target_device_id: aliceDevice, snapshot_id: aliceSnapshot },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api(ctx.server, 'POST', '/restore', {
          token: bob.token,
          body: { target_device_id: bobDevice, snapshot_id: aliceSnapshot },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api(ctx.server, 'GET', `/restore/pending?device_id=${aliceDevice}`, { token: bob.token }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(ctx.server, 'GET', `/restore/${created.request_id}`, { token: bob.token })).statusCode,
    ).toBe(404);
    expect(
      (
        await api(ctx.server, 'PATCH', `/restore/${created.request_id}`, {
          token: bob.token,
          body: { status: 'completed' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/restore/stream?device_id=${aliceDevice}`, {
          headers: { authorization: `Bearer ${bob.token}` },
        })
      ).status,
    ).toBe(404);
    for (const id of ['nope', NIL_UUID]) {
      expect((await api(ctx.server, 'GET', `/restore/${id}`, { token: alice.token })).statusCode).toBe(404);
    }
    const status = (
      await api(ctx.server, 'GET', `/restore/${created.request_id}`, { token: alice.token })
    ).json<RestoreStatusResponse>();
    expect(status.request.status).toBe('pending');
  });
});

/** Minimal SSE reader over a fetch body. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(timeoutMs = 5000): Promise<{ data?: unknown; comment?: string }> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.startsWith(':')) return { comment: block.slice(1).trim() };
          const data = block
            .split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6))
            .join('\n');
          return { data: JSON.parse(data) };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('SSE timeout');
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), remaining)),
        ]);
        if (chunk.done) throw new Error('SSE stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe('restore SSE stream', () => {
  it('sends the current state, then delivers NOTIFY-ed requests', async () => {
    const user = await registerUser(ctx.server);
    const target = await registerDevice(ctx.server, user.token, 'target');
    const other = await registerDevice(ctx.server, user.token, 'other');
    const snapshotId = await upload(user, other);

    const abort = new AbortController();
    const res = await fetch(`${baseUrl}/restore/stream?device_id=${target}`, {
      headers: { authorization: `Bearer ${user.token}`, origin: 'https://app.example.test' },
      signal: abort.signal,
    });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
      const events = sseReader(res.body!);
      expect((await events.next()).data).toEqual({ pending: false });

      // A request for ANOTHER device must not show up on this stream.
      await api(ctx.server, 'POST', '/restore', {
        token: user.token,
        body: { target_device_id: other, snapshot_id: snapshotId },
      });
      const created = (
        await api(ctx.server, 'POST', '/restore', {
          token: user.token,
          body: { target_device_id: target, snapshot_id: snapshotId },
        })
      ).json<CreateRestoreResponse>();

      const event = (await events.next()).data as PendingRestoreResponse;
      expect(event.pending).toBe(true);
      expect(event.request).toMatchObject({
        id: created.request_id,
        target_device_id: target,
        snapshot: { id: snapshotId },
      });
      // Local publish + LISTEN both fire for this instance: it must be delivered exactly once.
      await expect(events.next(1500)).rejects.toThrow('SSE timeout');
    } finally {
      abort.abort();
    }
  });

  it('delivers in real time without LISTEN when the database is behind a transaction pooler', async () => {
    const server = await buildServer({ ...testConfig(), restoreListen: 'off' });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/api/v1`;
    const abort = new AbortController();
    try {
      const user = await registerUser(server);
      const target = await registerDevice(server, user.token, 'target');
      const res = await fetch(`${url}/restore/stream?device_id=${target}`, {
        headers: { authorization: `Bearer ${user.token}` },
        signal: abort.signal,
      });
      const events = sseReader(res.body!);
      expect((await events.next()).data).toEqual({ pending: false });

      const payload = await encryptRestorePayload({ urls: ['https://example.org/'] }, user.masterKey, {
        userId: user.userId,
        targetDeviceId: target,
      });
      const created = (
        await api(server, 'POST', '/restore', {
          token: user.token,
          body: { target_device_id: target, ...payload },
        })
      ).json<CreateRestoreResponse>();
      const event = (await events.next()).data as PendingRestoreResponse;
      expect(event.request?.id).toBe(created.request_id);
      await expect(events.next(1500)).rejects.toThrow('SSE timeout');
    } finally {
      abort.abort();
      await server.close();
    }
  });

  it('withholds CORS headers for disallowed origins and caps concurrent streams per user', async () => {
    const user = await registerUser(ctx.server);
    const device = await registerDevice(ctx.server, user.token);
    const aborts: AbortController[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const abort = new AbortController();
        aborts.push(abort);
        const res = await fetch(`${baseUrl}/restore/stream?device_id=${device}`, {
          headers: { authorization: `Bearer ${user.token}`, origin: 'https://evil.test' },
          signal: abort.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
      }
      const over = await fetch(`${baseUrl}/restore/stream?device_id=${device}`, {
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ code: 'too_many_streams' });
    } finally {
      for (const a of aborts) a.abort();
    }
    // Closed streams free their slots.
    await new Promise(r => setTimeout(r, 200));
    const abort = new AbortController();
    const again = await fetch(`${baseUrl}/restore/stream?device_id=${device}`, {
      headers: { authorization: `Bearer ${user.token}` },
      signal: abort.signal,
    });
    expect(again.status).toBe(200);
    abort.abort();
  });

  it('ends open streams when the server shuts down', async () => {
    const server = await buildServer(testConfig());
    await server.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/api/v1`;
    const user = await registerUser(server);
    const device = await registerDevice(server, user.token);
    const res = await fetch(`${url}/restore/stream?device_id=${device}`, {
      headers: { authorization: `Bearer ${user.token}` },
    });
    const events = sseReader(res.body!);
    expect((await events.next()).data).toEqual({ pending: false });
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(events.next(2000)).rejects.toThrow(/ended/);
  });
});
