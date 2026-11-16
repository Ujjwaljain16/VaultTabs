import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bufferToBase64,
  createAccountMaterial,
  createPasswordMaterial,
  decryptLabel,
  decryptRestorePayload,
  decryptSnapshot,
  deriveAccountKeys,
  deriveLegacyWrappingKey,
  encryptLabel,
  encryptRestorePayload,
  encryptSnapshot,
  generateMasterKey,
  generateRecoveryCode,
  generateSalt,
  hashRecoveryCode,
  isSafeTabUrl,
  isWellFormedRecoveryCode,
  MIN_PBKDF2_ITERATIONS,
  normalizeRecoveryCode,
  unwrapMasterKey,
  unwrapMasterKeyWithRecoveryCode,
  wrapMasterKey,
} from './crypto.js';
import type { TabSnapshot } from './models.js';

const ITER = MIN_PBKDF2_ITERATIONS;
const tabs: TabSnapshot[] = [
  { id: 1, url: 'https://example.com/a', title: 'A', windowId: 1, index: 0, active: true, pinned: false },
  { id: 2, url: 'http://example.org/b', title: 'B', windowId: 1, index: 1, active: false, pinned: true },
];
const ctx = { userId: 'u1', deviceId: 'd1', capturedAt: '2026-01-02T03:04:05.678Z' };

describe('encoding', () => {
  it('round-trips base64 including large buffers', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(60_000));
    expect(base64ToBytes(bufferToBase64(bytes))).toEqual(bytes);
  });
});

describe('account keys (v2)', () => {
  it('is deterministic and separates auth key from wrapping key', async () => {
    const salt = generateSalt();
    const a = await deriveAccountKeys('correct horse battery', salt, ITER);
    const b = await deriveAccountKeys('correct horse battery', salt, ITER);
    const c = await deriveAccountKeys('wrong horse battery', salt, ITER);
    expect(a.authKey).toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
    expect(base64ToBytes(a.authKey)).toHaveLength(32);
    expect(a.wrappingKey.extractable).toBe(false);
  });

  it('rejects unsafe iteration counts', async () => {
    await expect(deriveAccountKeys('pw', generateSalt(), 1000)).rejects.toThrow(/iteration/);
  });

  it('creates account material whose wrapped key unwraps with the password only', async () => {
    const { masterKey, recoveryCode, payload } = await createAccountMaterial('hunter2hunter2', ITER);
    expect(masterKey.extractable).toBe(false);
    expect(payload.kdf_version).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('hunter2hunter2');

    const { wrappingKey } = await deriveAccountKeys('hunter2hunter2', payload.salt, payload.kdf_iterations);
    const unwrapped = await unwrapMasterKey(payload.encrypted_master_key, payload.master_key_iv, wrappingKey);
    const sealed = await encryptSnapshot(tabs, masterKey, ctx);
    expect(await decryptSnapshot(sealed.encrypted_blob, sealed.iv, unwrapped, 2, ctx)).toEqual(tabs);

    const wrong = await deriveAccountKeys('nope-nope-nope', payload.salt, payload.kdf_iterations);
    await expect(
      unwrapMasterKey(payload.encrypted_master_key, payload.master_key_iv, wrong.wrappingKey),
    ).rejects.toThrow();

    const recovered = await unwrapMasterKeyWithRecoveryCode(
      payload.recovery_encrypted_master_key,
      payload.recovery_key_iv,
      payload.recovery_key_salt,
      recoveryCode.toLowerCase(),
    );
    expect(await decryptSnapshot(sealed.encrypted_blob, sealed.iv, recovered, 2, ctx)).toEqual(tabs);
    expect(payload.recovery_key_hash).toBe(await hashRecoveryCode(recoveryCode));
  });

  it('re-wraps under a new password', async () => {
    const mk = await generateMasterKey();
    const next = await createPasswordMaterial(mk, 'new password!!', ITER);
    const { wrappingKey } = await deriveAccountKeys('new password!!', next.salt, ITER);
    await expect(
      unwrapMasterKey(next.encrypted_master_key, next.master_key_iv, wrappingKey),
    ).resolves.toBeTruthy();
  });

  it('still unwraps legacy (v1) wrapped keys', async () => {
    const mk = await generateMasterKey();
    const salt = generateSalt();
    const wrapped = await wrapMasterKey(mk, await deriveLegacyWrappingKey('legacy-pw', salt));
    const k = await unwrapMasterKey(
      wrapped.encrypted_master_key,
      wrapped.master_key_iv,
      await deriveLegacyWrappingKey('legacy-pw', salt),
    );
    expect(k.algorithm.name).toBe('AES-GCM');
  });
});

describe('snapshots', () => {
  it('binds v2 snapshots to user, device and time', async () => {
    const mk = await generateMasterKey();
    const s = await encryptSnapshot(tabs, mk, ctx);
    await expect(
      decryptSnapshot(s.encrypted_blob, s.iv, mk, 2, { ...ctx, deviceId: 'd2' }),
    ).rejects.toThrow();
    await expect(decryptSnapshot(s.encrypted_blob, s.iv, mk, 2, { ...ctx, userId: 'u2' })).rejects.toThrow();
    await expect(
      decryptSnapshot(s.encrypted_blob, s.iv, mk, 2, { ...ctx, capturedAt: '2026-01-02T03:04:06.678Z' }),
    ).rejects.toThrow();
    await expect(
      decryptSnapshot(s.encrypted_blob, s.iv, mk, 2, { ...ctx, capturedAt: new Date(ctx.capturedAt) }),
    ).resolves.toEqual(tabs);
  });

  it('rejects unknown versions', async () => {
    const mk = await generateMasterKey();
    const s = await encryptSnapshot(tabs, mk, ctx);
    await expect(decryptSnapshot(s.encrypted_blob, s.iv, mk, 9, ctx)).rejects.toThrow(/Unsupported/);
  });
});

describe('restore payloads and labels', () => {
  it('encrypts URLs for one target device only and drops unsafe URLs', async () => {
    const mk = await generateMasterKey();
    const rctx = { userId: 'u1', targetDeviceId: 't1' };
    const p = await encryptRestorePayload({ urls: ['https://a.example', 'javascript:alert(1)'] }, mk, rctx);
    expect(await decryptRestorePayload(p.encrypted_payload, p.payload_iv, mk, rctx)).toEqual({
      urls: ['https://a.example'],
    });
    await expect(
      decryptRestorePayload(p.encrypted_payload, p.payload_iv, mk, { ...rctx, targetDeviceId: 't2' }),
    ).rejects.toThrow();
    await expect(encryptRestorePayload({ urls: ['file:///etc/passwd'] }, mk, rctx)).rejects.toThrow();
  });

  it('round-trips labels bound to a snapshot', async () => {
    const mk = await generateMasterKey();
    const l = await encryptLabel('Thesis research', mk, 'u1', 's1');
    expect(await decryptLabel(l.label_enc, l.label_iv, mk, 'u1', 's1')).toBe('Thesis research');
    await expect(decryptLabel(l.label_enc, l.label_iv, mk, 'u1', 's2')).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('recovery codes are well-formed and normalized', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^VAULT(-[A-Z2-9]{4}){5}$/);
    expect(isWellFormedRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(isWellFormedRecoveryCode('VAULT-1111-0000')).toBe(false);
    expect(normalizeRecoveryCode(' vault-ab cd ')).toBe('VAULTABCD');
  });

  it('only allows http(s) URLs', () => {
    expect(isSafeTabUrl('https://x.y/z')).toBe(true);
    expect(isSafeTabUrl('HTTP://x.y')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///c',
      'chrome://settings',
      'not a url',
      42,
    ]) {
      expect(isSafeTabUrl(bad)).toBe(false);
    }
  });
});
