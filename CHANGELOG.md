# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The backend, PWA, extension and `shared`
package are versioned together.

## [Unreleased]

## [1.0.0] - 2026-11-16

First open-source release. This version reworks the cryptography so that the server never sees anything
that can decrypt your tabs. See [docs/security-model.md](docs/security-model.md) for the full design.

### Breaking changes

- **Auth v2 (`kdf_version` 2).** The account password is no longer sent to the server. The client derives
  a root key with PBKDF2-HMAC-SHA256 (600,000 iterations by default, stored per account) and splits it with
  HKDF into an `auth_key` (sent to the server, stored as scrypt) and a wrapping key (never leaves the
  client). New `POST /auth/prelogin` returns the KDF parameters. Legacy v1 accounts log in once with their
  password and are upgraded automatically (`POST /auth/upgrade`); old clients cannot log in to upgraded
  accounts.
- **Snapshots must use `enc_version` 2.** Snapshot ciphertexts are bound with AES-GCM additional
  authenticated data to the user id, device id and capture time. The server rejects new `enc_version` 1
  uploads; existing v1 snapshots stay readable.
- **"Send tab" payloads are end-to-end encrypted** and bound to the target device. The plaintext
  `target_url` field and free-text restore error messages were removed; failures are reported as fixed
  error codes (`RESTORE_ERROR_CODES`).
- **Browser fingerprinting removed.** Devices are identified only by their random device id; the
  `fingerprint` column is no longer written or read.
- Upgraded to **Fastify 5** and **Next.js 16** (React 19). Node.js >= 20.9 is required (22 recommended).
- TLS configuration: the backend now takes `TLS_CERT_FILE` / `TLS_KEY_FILE` instead of a hard-coded
  `certs/` directory and `HTTPS_ENABLED`; the mkcert helper script (`update-ip.ps1`) was removed.
- The extension requires `VITE_API_URL` at production build time; it becomes the only host permission.
- All API routes live under `/api/v1` and share one contract defined in `shared/src/api.ts`.

### Added

- Saved sessions with encrypted labels (never pruned by retention).
- Snapshot history / time travel with a diff between any two snapshots.
- Search across the tabs of all devices.
- Send a tab, a window or a whole snapshot to another device, delivered in real time over Server-Sent
  Events backed by Postgres `LISTEN/NOTIFY`.
- Export as JSON or as a bookmarks HTML file (import into any browser).
- Change password, regenerate recovery code, and "sign out everywhere".
- Server-side session revocation via a per-user `token_version`; password change and account recovery
  revoke all other sessions.
- Per-account snapshot retention control (1-500, default 50).
- PWA: strict nonce-based Content-Security-Policy, optional non-persistent key ("don't remember this
  device") and auto-lock.
- Extension: per-domain "never sync" list.
- Account recovery now issues a fresh recovery code (the old one is consumed).
- Versioned SQL migrations (`schema_migrations` table), `/health` and `/ready` endpoints, graceful
  shutdown, structured pino logs with secret redaction, and an in-process cleanup job
  (`CLEANUP_INTERVAL_MINUTES`).
- Docker images (Node 22 Alpine, non-root) and a Docker Compose stack (Postgres, backend, PWA).
- Automated tests (Vitest) for the shared crypto and backend integration, GitHub Actions CI, CodeQL,
  Dependabot, release workflow that builds Chrome and Firefox extension zips.
- Open-source project files: MIT license, contributing guide, security policy, code of conduct, and
  documentation (architecture, security model, self-hosting, API).

### Fixed

- **Device takeover:** registering a device with another user's device id could claim that device. A
  device id is now only reused when it already belongs to the caller.
- Snapshot retention of `0` (or an invalid value) could delete all snapshots; retention is now validated to
  1-500 and pinned snapshots are never pruned.
- Account statistics (snapshot count, storage, last sync) were computed incorrectly.
- Duplicate snapshot uploads when several tab events fired at once; unchanged tab lists are no longer
  re-uploaded.
- Tokens stayed valid after a password reset and could not be revoked; all sessions are now revocable.
- Prelogin and recovery-material endpoints return deterministic fake data for unknown emails instead of
  revealing whether an account exists.

### Security

- Development mkcert certificates and private keys that were committed in early history have been removed
  from the tree. Treat them as compromised (see [SECURITY.md](SECURITY.md)).

[Unreleased]: https://github.com/Ujjwaljain16/VaultTabs/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ujjwaljain16/VaultTabs/releases/tag/v1.0.0
