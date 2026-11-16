import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthResponse, PreloginResponse, RecoveryMaterialResponse } from '@vaulttabs/shared';
import {
  createPasswordMaterial,
  createRecoveryMaterial,
  decryptSnapshot,
  deriveAccountKeys,
  deriveLegacyWrappingKey,
  encryptSnapshot,
  generateMasterKey,
  generateRecoveryCode,
  generateSalt,
  hashRecoveryCode,
  unwrapMasterKey,
  unwrapMasterKeyWithRecoveryCode,
  wrapMasterKey,
} from '@vaulttabs/shared/crypto';
import {
  api,
  ITERATIONS,
  registerUser,
  setup,
  teardown,
  uniqueEmail,
  unwrapWithPassword,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));

const isB64Len = (v: string, n: number) =>
  Buffer.from(v, 'base64').length === n && Buffer.from(v, 'base64').toString('base64') === v;

/** Proves two master keys are the same key (encrypt with one, decrypt with the other). */
async function sameKey(a: CryptoKey, b: CryptoKey) {
  const ctx2 = { userId: 'u', deviceId: 'd', capturedAt: new Date(0) };
  const enc = await encryptSnapshot(
    [{ id: 1, url: 'https://x.test/', title: 't', windowId: 1, index: 0, active: true, pinned: false }],
    a,
    ctx2,
  );
  const tabs = await decryptSnapshot(enc.encrypted_blob, enc.iv, b, enc.enc_version, ctx2);
  expect(tabs[0]?.url).toBe('https://x.test/');
}

describe('health', () => {
  it('serves /health and /ready', async () => {
    const health = await api(ctx.server, 'GET', '/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', version: expect.any(String) });
    const ready = await api(ctx.server, 'GET', '/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready' });
  });

  it('returns ApiError for unknown routes and malformed JSON', async () => {
    const res = await api(ctx.server, 'GET', '/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', code: 'not_found', message: expect.any(String) });

    const bad = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'Bad Request', code: expect.any(String) });
  });

  it('only sends CORS headers to allowed origins', async () => {
    const allowed = await api(ctx.server, 'GET', '/health', {
      headers: { origin: 'https://app.example.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.test');
    const ext = await api(ctx.server, 'GET', '/health', { headers: { origin: 'chrome-extension://abcdef' } });
    expect(ext.headers['access-control-allow-origin']).toBe('chrome-extension://abcdef');
    const denied = await api(ctx.server, 'GET', '/health', { headers: { origin: 'https://evil.test' } });
    expect(denied.statusCode).toBe(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('register / prelogin / login (kdf v2)', () => {
  it('registers, never returns secrets, and logs in with auth_key', async () => {
    const user = await registerUser(ctx.server);
    expect(user.auth.user).toMatchObject({
      email: user.email,
      kdf_version: 2,
      has_recovery_key: true,
      snapshot_retention: 50,
    });
    expect(user.auth.upgrade_required).toBeUndefined();
    const raw = JSON.stringify(user.auth);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('token_version');
    expect(raw).not.toContain('recovery_key_hash');
    expect(raw).not.toContain(user.authKey);

    const pre = await api(ctx.server, 'POST', '/auth/prelogin', { body: { email: user.email } });
    expect(pre.statusCode).toBe(200);
    const params = pre.json<PreloginResponse>();
    expect(params).toEqual({ kdf_version: 2, kdf_iterations: ITERATIONS, salt: user.auth.crypto.salt });

    const { authKey } = await deriveAccountKeys(user.password, params.salt, params.kdf_iterations);
    expect(authKey).toBe(user.authKey);
    const login = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: user.email, auth_key: authKey },
    });
    expect(login.statusCode).toBe(200);
    const auth = login.json<AuthResponse>();
    expect(auth.token).toEqual(expect.any(String));
    await sameKey(user.masterKey, await unwrapWithPassword(auth, user.password));

    const me = await api(ctx.server, 'GET', '/auth/me', { token: auth.token });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: user.userId }, crypto: { salt: params.salt } });

    const [row] = await ctx.sql<{ password_hash: string; recovery_key_hash: string }[]>`
      SELECT password_hash, recovery_key_hash FROM users WHERE id = ${user.userId}`;
    expect(row!.password_hash).toMatch(/^scrypt\$15\$8\$1\$/);
    expect(row!.recovery_key_hash).toMatch(/^scrypt\$15\$8\$1\$/);
  });

  it('rejects a wrong auth_key and an unknown email with the same 401', async () => {
    const user = await registerUser(ctx.server);
    const wrong = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: user.email, auth_key: randomBytes(32).toString('base64') },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'invalid_credentials' });
    const unknown = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: uniqueEmail('ghost'), auth_key: randomBytes(32).toString('base64') },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    // A v2 account cannot be logged into with a password.
    const pw = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: user.email, password: user.password },
    });
    expect(pw.statusCode).toBe(401);
  });

  it('validates registration material', async () => {
    const master = await generateMasterKey();
    const material = await createPasswordMaterial(master, 'a long enough password', ITERATIONS);
    const recovery = await createRecoveryMaterial(master, generateRecoveryCode());
    const base = { email: uniqueEmail(), ...material, ...recovery };

    const cases: [string, Record<string, unknown>][] = [
      ['kdf_version 1', { ...base, kdf_version: 1 }],
      ['too few iterations', { ...base, kdf_iterations: 1000 }],
      ['too many iterations', { ...base, kdf_iterations: 100_000_000 }],
      ['short auth_key', { ...base, auth_key: randomBytes(16).toString('base64') }],
      ['missing recovery', { ...base, recovery_key_hash: undefined }],
      ['bad email', { ...base, email: 'not-an-email' }],
    ];
    for (const [name, body] of cases) {
      const res = await api(ctx.server, 'POST', '/auth/register', { body });
      expect(res.statusCode, name).toBe(400);
      expect(res.json(), name).toMatchObject({ code: 'validation_failed', message: expect.any(String) });
    }
    // The server never needs the password itself.
    const ok = await api(ctx.server, 'POST', '/auth/register', { body: base });
    expect(ok.statusCode).toBe(201);
  });

  it('treats emails case-insensitively', async () => {
    const lower = uniqueEmail('mixed');
    const user = await registerUser(ctx.server, `  ${lower.toUpperCase()} `);
    expect(user.email).toBe(lower);

    const dup = await api(ctx.server, 'POST', '/auth/register', {
      body: { ...(await registerPayload()), email: lower.replace('mixed', 'MIXED') },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'email_taken' });

    const login = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: lower.toUpperCase(), auth_key: user.authKey },
    });
    expect(login.statusCode).toBe(200);
    const pre = await api(ctx.server, 'POST', '/auth/prelogin', {
      body: { email: ` ${lower.toUpperCase()}` },
    });
    expect(pre.json<PreloginResponse>().salt).toBe(user.auth.crypto.salt);
  });
});

async function registerPayload() {
  const master = await generateMasterKey();
  const material = await createPasswordMaterial(master, 'another long password', ITERATIONS);
  return { ...material, ...(await createRecoveryMaterial(master, generateRecoveryCode())) };
}

describe('anti-enumeration fakes', () => {
  it('prelogin returns deterministic, well-formed parameters for unknown emails', async () => {
    const email = uniqueEmail('nobody');
    const a = (await api(ctx.server, 'POST', '/auth/prelogin', { body: { email } })).json<PreloginResponse>();
    const b = (
      await api(ctx.server, 'POST', '/auth/prelogin', { body: { email: email.toUpperCase() } })
    ).json<PreloginResponse>();
    const other = (
      await api(ctx.server, 'POST', '/auth/prelogin', { body: { email: uniqueEmail('nobody') } })
    ).json<PreloginResponse>();
    expect(a).toEqual(b);
    expect(a.kdf_version).toBe(2);
    expect(a.kdf_iterations).toBeGreaterThanOrEqual(ITERATIONS);
    expect(isB64Len(a.salt, 32)).toBe(true);
    expect(other.salt).not.toBe(a.salt);
  });

  it('recovery-material returns deterministic, well-formed material for unknown emails', async () => {
    const email = uniqueEmail('nobody');
    const res = await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email } });
    expect(res.statusCode).toBe(200);
    const a = res.json<RecoveryMaterialResponse>();
    const b = (
      await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email } })
    ).json<RecoveryMaterialResponse>();
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual([
      'recovery_encrypted_master_key',
      'recovery_key_iv',
      'recovery_key_salt',
    ]);
    expect(isB64Len(a.recovery_encrypted_master_key, 48)).toBe(true);
    expect(isB64Len(a.recovery_key_iv, 12)).toBe(true);
    expect(isB64Len(a.recovery_key_salt, 32)).toBe(true);

    // Same shape for a real account.
    const user = await registerUser(ctx.server);
    const real = (
      await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email: user.email } })
    ).json<RecoveryMaterialResponse>();
    expect(Object.keys(real).sort()).toEqual(Object.keys(a).sort());
    expect(isB64Len(real.recovery_encrypted_master_key, 48)).toBe(true);
  });
});

describe('legacy (kdf v1) accounts', () => {
  it('logs in with the password, upgrades to v2, then logs in with auth_key', async () => {
    const email = uniqueEmail('legacy');
    const password = 'legacy password 123';
    const salt = generateSalt();
    const master = await generateMasterKey();
    const wrapped = await wrapMasterKey(master, await deriveLegacyWrappingKey(password, salt));
    const hashSalt = randomBytes(16).toString('hex');
    const legacyHash = `${hashSalt}:${scryptSync(password, hashSalt, 64).toString('hex')}`;
    const [inserted] = await ctx.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, encrypted_master_key, master_key_iv, salt)
      VALUES (${email}, ${legacyHash}, ${wrapped.encrypted_master_key}, ${wrapped.master_key_iv}, ${salt})
      RETURNING id`;

    const pre = (
      await api(ctx.server, 'POST', '/auth/prelogin', { body: { email } })
    ).json<PreloginResponse>();
    expect(pre).toEqual({ kdf_version: 1, kdf_iterations: 100000, salt });

    const wrongPw = await api(ctx.server, 'POST', '/auth/login', {
      body: { email, password: 'nope nope nope' },
    });
    expect(wrongPw.statusCode).toBe(401);

    const login = await api(ctx.server, 'POST', '/auth/login', { body: { email, password } });
    expect(login.statusCode).toBe(200);
    const legacyAuth = login.json<AuthResponse>();
    expect(legacyAuth.upgrade_required).toBe(true);
    expect(legacyAuth.user.kdf_version).toBe(1);
    expect(legacyAuth.user.has_recovery_key).toBe(false);

    // The legacy hash was transparently replaced by the current format.
    const [row] = await ctx.sql<
      { password_hash: string }[]
    >`SELECT password_hash FROM users WHERE id = ${inserted!.id}`;
    expect(row!.password_hash).toMatch(/^scrypt\$/);
    expect((await api(ctx.server, 'POST', '/auth/login', { body: { email, password } })).statusCode).toBe(
      200,
    );

    // Client-side upgrade: unwrap with the legacy key, re-wrap under v2 material.
    const unwrapped = await unwrapMasterKey(
      legacyAuth.crypto.encrypted_master_key,
      legacyAuth.crypto.master_key_iv,
      await deriveLegacyWrappingKey(password, legacyAuth.crypto.salt),
      true,
    );
    const material = await createPasswordMaterial(unwrapped, password, ITERATIONS);

    const wrongUpgrade = await api(ctx.server, 'POST', '/auth/upgrade', {
      token: legacyAuth.token,
      body: { password: 'wrong password!!', ...material },
    });
    expect(wrongUpgrade.statusCode).toBe(403);

    const upgrade = await api(ctx.server, 'POST', '/auth/upgrade', {
      token: legacyAuth.token,
      body: { password, ...material },
    });
    expect(upgrade.statusCode).toBe(200);
    const upgraded = upgrade.json<AuthResponse>();
    expect(upgraded.user.kdf_version).toBe(2);
    expect(upgraded.upgrade_required).toBeUndefined();

    const again = await api(ctx.server, 'POST', '/auth/upgrade', {
      token: upgraded.token,
      body: { password, ...material },
    });
    expect(again.statusCode).toBe(409);

    // Now only auth_key works.
    expect((await api(ctx.server, 'POST', '/auth/login', { body: { email, password } })).statusCode).toBe(
      401,
    );
    const v2 = await api(ctx.server, 'POST', '/auth/login', { body: { email, auth_key: material.auth_key } });
    expect(v2.statusCode).toBe(200);
    await sameKey(master, await unwrapWithPassword(v2.json<AuthResponse>(), password));
  });
});

describe('session revocation', () => {
  it('logout-all ends every other session and returns a fresh token', async () => {
    const user = await registerUser(ctx.server);
    const second = (
      await api(ctx.server, 'POST', '/auth/login', { body: { email: user.email, auth_key: user.authKey } })
    ).json<AuthResponse>();

    const res = await api(ctx.server, 'POST', '/auth/logout-all', { token: user.token });
    expect(res.statusCode).toBe(200);
    const fresh = res.json<AuthResponse>();

    for (const old of [user.token, second.token]) {
      const me = await api(ctx.server, 'GET', '/auth/me', { token: old });
      expect(me.statusCode).toBe(401);
      expect(me.json()).toMatchObject({ code: 'token_invalid' });
    }
    expect((await api(ctx.server, 'GET', '/auth/me', { token: fresh.token })).statusCode).toBe(200);
  });

  it('change-password requires the current credential, revokes old tokens, and keeps the master key', async () => {
    const user = await registerUser(ctx.server);
    const master = await unwrapWithPassword(user.auth, user.password);
    const next = await createPasswordMaterial(master, 'a brand new password', ITERATIONS);

    const wrong = await api(ctx.server, 'POST', '/auth/change-password', {
      token: user.token,
      body: { current: { auth_key: randomBytes(32).toString('base64') }, next },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: 'invalid_credentials' });

    const wrongType = await api(ctx.server, 'POST', '/auth/change-password', {
      token: user.token,
      body: { current: { password: user.password }, next },
    });
    expect(wrongType.statusCode).toBe(400);

    const res = await api(ctx.server, 'POST', '/auth/change-password', {
      token: user.token,
      body: { current: { auth_key: user.authKey }, next },
    });
    expect(res.statusCode).toBe(200);
    const fresh = res.json<AuthResponse>();
    expect((await api(ctx.server, 'GET', '/auth/me', { token: user.token })).json()).toMatchObject({
      code: 'token_invalid',
    });
    expect((await api(ctx.server, 'GET', '/auth/me', { token: fresh.token })).statusCode).toBe(200);

    expect(
      (await api(ctx.server, 'POST', '/auth/login', { body: { email: user.email, auth_key: user.authKey } }))
        .statusCode,
    ).toBe(401);
    const login = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: user.email, auth_key: next.auth_key },
    });
    expect(login.statusCode).toBe(200);
    await sameKey(
      user.masterKey,
      await unwrapWithPassword(login.json<AuthResponse>(), 'a brand new password'),
    );
  });

  it('recover sets a new password and recovery code and revokes sessions', async () => {
    const user = await registerUser(ctx.server);
    const material = (
      await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email: user.email } })
    ).json<RecoveryMaterialResponse>();
    const master = await unwrapMasterKeyWithRecoveryCode(
      material.recovery_encrypted_master_key,
      material.recovery_key_iv,
      material.recovery_key_salt,
      user.recoveryCode,
    );
    const newCode = generateRecoveryCode();
    const body = {
      email: user.email.toUpperCase(),
      recovery_key_hash: await hashRecoveryCode(user.recoveryCode),
      next: await createPasswordMaterial(master, 'recovered password!', ITERATIONS),
      recovery: await createRecoveryMaterial(master, newCode),
    };

    const bad = await api(ctx.server, 'POST', '/auth/recover', {
      body: { ...body, recovery_key_hash: await hashRecoveryCode(generateRecoveryCode()) },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: 'invalid_recovery_code' });
    const unknown = await api(ctx.server, 'POST', '/auth/recover', {
      body: { ...body, email: uniqueEmail('ghost') },
    });
    expect(unknown.statusCode).toBe(401);

    const res = await api(ctx.server, 'POST', '/auth/recover', { body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ message: expect.any(String) });

    expect((await api(ctx.server, 'GET', '/auth/me', { token: user.token })).json()).toMatchObject({
      code: 'token_invalid',
    });
    const login = await api(ctx.server, 'POST', '/auth/login', {
      body: { email: user.email, auth_key: body.next.auth_key },
    });
    expect(login.statusCode).toBe(200);
    await sameKey(
      user.masterKey,
      await unwrapWithPassword(login.json<AuthResponse>(), 'recovered password!'),
    );

    // The old recovery code is gone; the new one works.
    expect((await api(ctx.server, 'POST', '/auth/recover', { body })).statusCode).toBe(401);
    const newMaterial = (
      await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email: user.email } })
    ).json<RecoveryMaterialResponse>();
    await sameKey(
      user.masterKey,
      await unwrapMasterKeyWithRecoveryCode(
        newMaterial.recovery_encrypted_master_key,
        newMaterial.recovery_key_iv,
        newMaterial.recovery_key_salt,
        newCode,
      ),
    );
  });

  it('recovery-code replaces the recovery material', async () => {
    const user = await registerUser(ctx.server);
    const master = await unwrapWithPassword(user.auth, user.password);
    const code = generateRecoveryCode();
    const recovery = await createRecoveryMaterial(master, code);
    const res = await api(ctx.server, 'POST', '/auth/recovery-code', {
      token: user.token,
      body: { current: { auth_key: user.authKey }, recovery },
    });
    expect(res.statusCode).toBe(200);
    const material = (
      await api(ctx.server, 'POST', '/auth/recovery-material', { body: { email: user.email } })
    ).json<RecoveryMaterialResponse>();
    expect(material.recovery_key_salt).toBe(recovery.recovery_key_salt);
    // Session stays valid.
    expect((await api(ctx.server, 'GET', '/auth/me', { token: user.token })).statusCode).toBe(200);
  });

  it('a deleted account token gets 401 token_invalid', async () => {
    const user = await registerUser(ctx.server);
    const wrong = await api(ctx.server, 'DELETE', '/account', {
      token: user.token,
      body: { current: { auth_key: randomBytes(32).toString('base64') } },
    });
    expect(wrong.statusCode).toBe(403);
    const res = await api(ctx.server, 'DELETE', '/account', {
      token: user.token,
      body: { current: { auth_key: user.authKey } },
    });
    expect(res.statusCode).toBe(200);
    const me = await api(ctx.server, 'GET', '/auth/me', { token: user.token });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ code: 'token_invalid' });
    const [row] = await ctx.sql`SELECT 1 FROM users WHERE id = ${user.userId}`;
    expect(row).toBeUndefined();
  });

  it('rejects missing, forged and alg=none tokens', async () => {
    const user = await registerUser(ctx.server);
    const missing = (await api(ctx.server, 'GET', '/auth/me')).json();
    expect(missing).toEqual({ error: 'Unauthorized', message: expect.any(String), code: 'unauthorized' });
    const [h, p] = user.token.split('.');
    const forged = `${h}.${p}.${Buffer.from('x'.repeat(32)).toString('base64url')}`;
    expect((await api(ctx.server, 'GET', '/auth/me', { token: forged })).json()).toMatchObject({
      code: 'token_invalid',
    });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    expect((await api(ctx.server, 'GET', '/auth/me', { token: none })).statusCode).toBe(401);
  });

  it('rate-limits login attempts per IP', async () => {
    const ip = '192.0.2.77';
    const body = { email: uniqueEmail('rl'), auth_key: randomBytes(32).toString('base64') };
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (await api(ctx.server, 'POST', '/auth/login', { ip, body })).statusCode;
    expect(last).toBe(429);
    const res = await api(ctx.server, 'POST', '/auth/login', { ip, body });
    expect(res.json()).toEqual({
      error: 'Too Many Requests',
      message: expect.any(String),
      code: 'rate_limited',
    });
  });
});
