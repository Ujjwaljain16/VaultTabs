# Security model

This document describes what VaultTabs protects, against whom, and how. It is meant to be precise and
honest: where something is **not** protected it says so. The cryptography lives in a single file,
[`shared/src/crypto.ts`](../shared/src/crypto.ts); the parameters below are copied from it. If this document
and the code ever disagree, the code is what runs, and the disagreement is a bug (please report it).

- [Summary](#summary)
- [Assets](#assets)
- [Actors and what they can do](#actors-and-what-they-can-do)
- [Cryptographic design](#cryptographic-design)
- [Authentication and sessions](#authentication-and-sessions)
- [Legacy (v1) accounts and migration](#legacy-v1-accounts-and-migration)
- [Client hardening](#client-hardening)
- [Server hardening](#server-hardening)
- [Known limitations](#known-limitations)

## Summary

| Data                                                          | Who can read it                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Tab URLs, titles, favicon URLs, window/tab layout (snapshots) | Only your clients. Server stores AES-256-GCM ciphertext.                      |
| URLs sent with "send tab / window"                            | Only your clients (encrypted, bound to the target device).                    |
| Saved-session labels                                          | Only your clients (encrypted).                                                |
| Account password, master key, wrapping key, recovery code     | Never leave your device.                                                      |
| `auth_key` (derived from the password)                        | Server, during login; stored only as an scrypt hash. Cannot decrypt anything. |
| Email address                                                 | Server (plaintext).                                                           |
| Device names and ids, created/last-seen times                 | Server (plaintext).                                                           |
| Snapshot timestamps, count, sizes, pinned flag                | Server (plaintext). Size correlates with the number of tabs.                  |
| Which device sent something to which device, and when         | Server.                                                                       |
| IP addresses, user agents, request timing                     | Server and anything in front of it (reverse proxy, CDN).                      |

VaultTabs is end-to-end encrypted for **content**, not for **metadata**, and the web dashboard (PWA) is only
as trustworthy as the server that serves its JavaScript (see
[malicious operator](#a-malicious-server-operator)).

## Assets

1. **Tab content**: URLs and titles reveal browsing activity; this is the main asset.
2. **Keys**: the master key (decrypts everything), the account password and the recovery code (each can
   recover the master key).
3. **Integrity of what clients display and open**: a client must not show forged tabs, attribute a
   snapshot to the wrong device or time, or open URLs the user never sent.
4. **Account control**: sessions (JWTs), the ability to change the password, delete devices or the account.
5. **Metadata**: email, device names, activity patterns. Visible to the server by design, but should not
   leak to other users or unauthenticated parties.

## Actors and what they can do

### Honest-but-curious server / operator

Sees everything in the "Server" rows of the summary table. It receives `auth_key` at login, which is an
HKDF output independent of the wrapping key: knowing it does not help to unwrap the master key. To read
tabs, the operator would have to guess your password (offline, at the PBKDF2 cost below) or actively attack
clients (next section).

### A malicious server operator

An operator that is willing to modify the server or the code it serves can:

- **Serve malicious PWA JavaScript.** This is inherent to every web-based crypto app: the PWA is delivered
  by the operator on each visit, so modified JS could capture your password or master key. The strict CSP
  protects against third-party script injection, not against the origin itself. **The browser extension is
  the stronger client**: its code is fixed at install time (and reviewed by the stores if you install from
  there, or built by you from source).
- **Withhold data or serve older snapshots.** The server can refuse to store or return snapshots, drop
  "send tab" requests, or return an older but genuine snapshot as "latest". It cannot relabel that older
  snapshot as newer: the capture time is authenticated (AAD), so clients display the true timestamp and a
  rollback is detectable (the newest snapshot appears stale).
- **Not forge or move content.** Any change to a ciphertext, or presenting a snapshot under a different
  user, device or timestamp, fails AES-GCM authentication on the client.
- **Replay a "send tab" payload to the same target device.** Send-tab payloads are bound to user and target
  device but not to a request id or time, so the server could deliver the same (genuine) set of URLs again.
  It cannot choose the URLs. Snapshot-based restores reference a snapshot id; the server could substitute
  another genuine snapshot of the same account.
- **Lie about KDF parameters.** Iterations are bounded client-side
  (`MIN_PBKDF2_ITERATIONS` = 600,000, `MAX_PBKDF2_ITERATIONS` = 10,000,000), so the server can neither
  weaken the KDF nor make clients hang. See also the [legacy downgrade note](#known-limitations).
- **See all metadata** listed in the summary.

### Database thief (stolen dump or backup)

Gets ciphertexts, wrapped master keys, salts, KDF parameters, `scrypt(auth_key)`, the recovery verifier and
metadata. No snapshot is readable without the password or the recovery code. An offline password guess
costs one PBKDF2-HMAC-SHA256 with the account's iteration count (>= 600,000) plus an HKDF and an AES-GCM
unwrap attempt, so **password strength matters** (minimum length is 10 characters). Recovery codes carry
100 bits of entropy and are not guessable. Old backups taken before an account was upgraded still contain
the weaker [legacy material](#legacy-v1-accounts-and-migration).

### Network attacker

All traffic must go over HTTPS (WebCrypto requires a secure context anyway, except on `localhost`). With TLS
a network attacker learns only traffic patterns. Without TLS, an attacker can steal bearer tokens and
`auth_key`, observe metadata, and tamper with the PWA's JavaScript, but still cannot decrypt snapshots from
the wire. Production extension builds talk only to the `VITE_API_URL` they were built with; use `https://`.

### XSS in the PWA

The PWA uses a strict, nonce-based Content-Security-Policy (no inline or third-party scripts), React's
escaping, and never renders tab titles or URLs as HTML. Only `http(s)` URLs are ever rendered as links or
opened (`isSafeTabUrl`). If an XSS were found anyway, it would run with the page's privileges: it could
read the JWT from `localStorage` and use (not export) the non-extractable master key while the vault is
unlocked.

### Stolen or shared device

While a client is logged in and unlocked, whoever controls the browser profile can see your tabs. The master
key is stored as a **non-extractable** `CryptoKey` in IndexedDB (scripts can use it but cannot export its
bytes) and the token in `localStorage` (PWA) or `chrome.storage.local` (extension); neither is encrypted at
rest by VaultTabs. Mitigations: the PWA can keep the key **in memory only** ("don't remember this device")
and **auto-lock** after inactivity; "sign out everywhere" revokes all tokens; deleting a device from another
client removes it. If a device is lost, also consider changing your password (which revokes every session
and re-wraps the master key).

### Other users

All data access is scoped to the authenticated user id on the server; device ids, snapshot ids and restore
requests of other users are rejected (a device id is only reused at registration if it already belongs to
the caller). Unauthenticated parties can probe email existence only through registration (see limitations).

## Cryptographic design

All primitives are WebCrypto (`crypto.subtle`). Randomness comes from `crypto.getRandomValues`.

### Key hierarchy (kdf_version 2)

```text
password ──NFKC normalize──PBKDF2-HMAC-SHA256(salt, iterations)──► root (256 bit)
root ──HKDF-SHA256(salt, info "vaulttabs/v2/auth-key")──► auth_key (256 bit, sent to server)
root ──HKDF-SHA256(salt, info "vaulttabs/v2/wrap-key")──► wrapping key (AES-256-GCM, non-extractable)

master key = random AES-256-GCM key
   ├─ wrapped by the wrapping key            → encrypted_master_key, master_key_iv
   └─ wrapped by the recovery-code key        → recovery_encrypted_master_key, recovery_key_iv
```

| Parameter               | Value                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Password KDF            | PBKDF2-HMAC-SHA256, 256-bit output, password normalized with Unicode NFKC                  |
| Iterations              | `DEFAULT_PBKDF2_ITERATIONS` = 600,000; accepted range 600,000 to 10,000,000 (per account)  |
| Salt                    | 32 random bytes per account (base64), regenerated on every password change                 |
| Key split               | HKDF-SHA256 with the same salt; `info` = `vaulttabs/v2/auth-key` / `vaulttabs/v2/wrap-key` |
| `auth_key`              | 32 bytes, base64. Server stores only an scrypt hash of it                                  |
| Wrapping key            | AES-256-GCM, non-extractable, usages `wrapKey`/`unwrapKey`                                 |
| Master key              | AES-256-GCM, generated by `generateKey`; stored non-extractable on clients                 |
| Master key wrap         | AES-GCM `wrapKey('raw', ...)`, 96-bit random IV, no AAD                                    |
| Minimum password length | 10 characters (`LIMITS.minPasswordChars`), maximum 1024                                    |

Because the two HKDF outputs are independent, the server learns nothing about the wrapping key from
`auth_key`. Changing the password generates a new salt, re-derives both keys and re-wraps the **same**
master key, so existing snapshots stay readable.

### Recovery code

| Parameter     | Value                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Format        | `VAULT-XXXX-XXXX-XXXX-XXXX-XXXX`: 20 symbols from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (5 bits each, no modulo bias) = 100 bits |
| Normalization | Remove spaces and dashes, upper-case (so the `VAULT` prefix is part of the normalized input)                                  |
| Wrapping key  | PBKDF2-HMAC-SHA256(normalized code, 32-byte random salt, 50,000 iterations) → AES-256-GCM                                     |
| Wrap          | AES-GCM `wrapKey('raw', masterKey)`, 96-bit random IV                                                                         |
| Verifier      | `recovery_key_hash` = base64(SHA-256(normalized code)); the server stores scrypt of it                                        |

The low iteration count is deliberate: the code's 100-bit entropy, not the KDF, makes guessing infeasible.
The code is shown once at registration and never stored. Recovery (`POST /auth/recover`) proves knowledge of
the code via the verifier, sets new password material **and a new recovery code**, and revokes all sessions.
The recovery-material endpoint returns deterministic fake but well-formed data for unknown emails.

### Snapshots (enc_version 2)

```text
plaintext  = JSON.stringify(TabSnapshot[])        // id, url, title, favIconUrl, windowId, index, active, pinned
ciphertext = AES-256-GCM(masterKey, iv = 12 random bytes, plaintext, AAD)
AAD        = "vaulttabs/snapshot/v2|" + userId + "|" + deviceId + "|" + capturedAt
capturedAt = new Date(captured_at).toISOString()   // canonicalTimestamp(), e.g. 2026-11-16T10:00:00.000Z
```

The AAD is UTF-8 encoded and is not transmitted; the client rebuilds it from what it trusts and displays: its
own user id, the device the snapshot is listed under and the timestamp shown. A server that moves a snapshot
to another device or user, or changes its `captured_at`, causes decryption to fail. After decryption,
entries are sanitized (only objects with a string `url`; fields coerced to their types). Clients only
capture and open `http:`/`https:` URLs of at most 8192 characters (`isSafeTabUrl`); incognito/private tabs
and domains on the extension's never-sync list are not captured.

`enc_version` 1 (legacy) snapshots were encrypted the same way **without** AAD; clients can still decrypt
them but new uploads must be version 2.

### Send tab / window (restore payloads)

```text
plaintext = JSON.stringify({ urls: string[] })    // only http(s) URLs; at most LIMITS.maxRestoreUrls (500)
AAD       = "vaulttabs/restore/v1|" + userId + "|" + targetDeviceId
```

The server stores only `encrypted_payload` and `payload_iv`. The receiving device decrypts with its own
device id, so a payload cannot be redirected to another device, and filters the URLs through
`isSafeTabUrl` again before opening them. Restoring a whole snapshot sends a `snapshot_id` instead; the
target decrypts that snapshot with the snapshot's AAD. Failures are reported with fixed codes
(`master_key_missing`, `decrypt_failed`, `empty_snapshot`, `unsafe_url`, `open_failed`, `unknown`), never
free text.

### Saved-session labels

```text
AAD = "vaulttabs/label/v1|" + userId + "|" + snapshotId
```

Stored as `label_enc` + `label_iv` (AES-256-GCM, master key, 96-bit random IV).

### Other

- Every AES-GCM operation uses a fresh 96-bit random IV. With one key per account and at most a few
  thousand encryptions per account per day, the random-IV collision bound is far from reach.
- Unchanged tab lists are detected with SHA-256 over the serialized list (`sha256Hex`) locally, so identical
  snapshots are not uploaded.

## Authentication and sessions

1. `POST /auth/prelogin { email }` returns `kdf_version`, `kdf_iterations` and `salt`. For unknown emails
   the server returns **deterministic fake** parameters derived from `PRELOGIN_SECRET`, so the response does
   not reveal whether an account exists (repeated queries return the same values).
2. The client derives `auth_key` and sends `POST /auth/login { email, auth_key }`. The server compares
   scrypt(`auth_key`) in constant time and returns a JWT, the user, and the wrapped master key.
3. The client unwraps the master key locally with the wrapping key.

Tokens are JWTs signed with HS256 (`JWT_SECRET`, at least 32 characters), valid for `JWT_EXPIRY` (default
30 days), and carry a per-user `token_version`. Every authenticated request checks the token version against
the database, which enables **server-side revocation**:

- "Sign out everywhere" (`POST /auth/logout-all`) increments `token_version` and returns a fresh token to the
  caller.
- Changing the password and account recovery increment it too, ending every other session.
- Deleting the account invalidates everything.

Sensitive operations (change password, regenerate recovery code, delete account) require proof of the
current credential (`auth_key`, or `password` for legacy accounts). A `401` with code `token_invalid` tells
clients to drop the session.

## Legacy (v1) accounts and migration

Before 1.0.0, accounts used `kdf_version` 1: the **password itself was sent** to the server (stored as
scrypt) and PBKDF2-HMAC-SHA256(password, salt, **100,000** iterations) was the wrapping key, with no
password normalization.

Migration is automatic:

1. Prelogin reports `kdf_version: 1`; the client logs in once with `{ email, password }` and receives
   `upgrade_required: true`.
2. The client unwraps the master key with the legacy wrapping key, creates fresh v2 password material
   (`createPasswordMaterial`) and calls `POST /auth/upgrade` (authenticated, with the password as proof).
3. The server replaces the password hash with scrypt(`auth_key`), stores the new wrapped master key and
   salt, and sets `kdf_version` 2. From then on the password never leaves the client.

The master key does not change, so existing snapshots remain readable. Note that the password was exposed
to the server before the upgrade, and DB backups from before the upgrade still contain the v1 material.
If that matters to you, change your password after upgrading.

## Client hardening

- **Extension**: requests only the host permission for the `VITE_API_URL` it was built with (required for
  production builds), no browser fingerprinting (devices are identified by a random id), only `http(s)`
  tabs, no incognito tabs, and a per-domain never-sync list. Its code cannot be changed by the server.
- **PWA**: strict nonce-based CSP, no third-party scripts, optional non-persistent master key and auto-lock,
  keys never rendered or logged.

## Server hardening

- Input validation on every route, with size limits (`LIMITS` in `shared/src/api.ts`).
- Authorization by user id on every query; device ids are reused only if they belong to the caller.
- Rate limiting (global, plus stricter limits on auth, prelogin, register and recovery).
- Security headers via helmet, CORS restricted to `ALLOWED_ORIGINS`.
- Secrets (tokens, `auth_key`, recovery material, authorization headers) are redacted from logs.
- Passwords/`auth_key` and recovery verifiers are stored with scrypt and compared in constant time.
- Postgres connections use TLS with certificate verification by default (`DATABASE_SSL=require`).

## Known limitations

These are deliberate trade-offs or open work. Contributions that remove them are welcome; please discuss
crypto changes in an issue first.

1. **Metadata is visible to the server**: email, device names, timestamps, snapshot sizes and counts, IP
   addresses, and which device sent what to which device.
2. **The PWA trusts the server that serves it.** A malicious or compromised operator can ship JavaScript
   that steals keys. Use the extension (built from source or installed from a store) as your primary
   client if you do not trust the operator, or self-host.
3. **Legacy downgrade.** Clients decide between the v2 and the legacy (password-sending) login from the
   `kdf_version` that prelogin returns. An actively malicious server could claim an upgraded account is
   still legacy and receive the password at the next login. This is in the same trust class as point 2 for
   the PWA; for the extension it is a real gap. Legacy support will be removed in a future major version.
4. **No email verification.** Registration (`409` on a taken email) reveals whether an email has an account;
   it is rate-limited. Prelogin and recovery-material do not leak this.
5. **JWT in `localStorage`** in the PWA (readable by an XSS). Mitigated by the strict CSP and server-side
   revocation; an httpOnly cookie design is possible future work.
6. **Rate limiting is in memory, per instance.** Running several backend instances multiplies the effective
   limits. Put a shared limiter (reverse proxy, WAF) in front if you scale out.
7. **Rollback and replay are detectable, not prevented.** The server can serve an older genuine snapshot
   (its true timestamp is shown) or re-deliver a genuine send-tab payload to the same device.
8. **Keys at rest on clients are not encrypted** by VaultTabs (beyond being non-extractable). Rely on OS
   disk encryption and screen locks; use the PWA's non-persistent mode on shared machines.
9. **Old development private keys in git history.** Early commits contained mkcert development certificates
   with private keys (`certs/*.pem`). They are not used by VaultTabs anymore; treat them as compromised. You
   can purge them from your clone's history with
   [`git filter-repo`](https://github.com/newren/git-filter-repo) (`git filter-repo --path certs --invert-paths`),
   which rewrites history and requires a force-push.
10. **No independent audit** has been performed yet.
