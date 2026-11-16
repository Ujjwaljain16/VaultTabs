# HTTP API

The contract is defined in TypeScript in [`shared/src/api.ts`](../shared/src/api.ts) (payload and response
types) and [`shared/src/models.ts`](../shared/src/models.ts) (domain models). That file is the source of
truth; this page is a readable index of it.

## Conventions

- **Base URL**: every path below is relative to the API URL, e.g. `https://api.example.com/api/v1`
  (`API_VERSION = 'v1'`). This is the value clients are configured with (`NEXT_PUBLIC_API_URL`,
  `VITE_API_URL`).
- **Auth**: routes marked "yes" require `Authorization: Bearer <jwt>`. The SSE stream accepts the same
  header (the clients use `fetch` streaming, not `EventSource`).
- **Bodies** are JSON. Binary values (ciphertexts, IVs, salts, keys) are base64 strings. Timestamps are ISO
  8601 strings.
- **Errors** always have the shape `ApiError`:

  ```json
  { "error": "Unauthorized", "message": "Session expired", "code": "token_invalid", "details": null }
  ```

  `401` with `code: "token_invalid"` means the session is gone (expired, revoked by sign-out-everywhere or a
  password change, or the account was deleted): drop the session and log in again. `429` means rate
  limited; `400` validation errors may include `details`.

- **Health** (outside `/api/v1`): `GET /health` (process is up) and `GET /ready` (database reachable), for
  load balancers and container health checks.

## Limits (`LIMITS`)

| Name                   | Value     | Meaning                                      |
| ---------------------- | --------- | -------------------------------------------- |
| `maxSnapshotBlobChars` | 2,000,000 | Max length of the base64 snapshot ciphertext |
| `maxDeviceNameChars`   | 100       | Device name length                           |
| `minPasswordChars`     | 10        | Enforced client-side (server never sees it)  |
| `maxPasswordChars`     | 1024      |                                              |
| `minRetention`         | 1         | Snapshots kept per device (unpinned)         |
| `maxRetention`         | 500       |                                              |
| `defaultRetention`     | 50        |                                              |
| `maxSavedSessions`     | 100       | Pinned snapshots per account                 |
| `maxHistoryPage`       | 50        | Page size of `/snapshots/history`            |
| `maxRestoreUrls`       | 500       | URLs per encrypted send-tab payload          |

## Auth

| Method & path                  | Auth | Body                        | Response                                                                   |
| ------------------------------ | ---- | --------------------------- | -------------------------------------------------------------------------- |
| `POST /auth/prelogin`          | no   | `PreloginPayload`           | `PreloginResponse` (fake but stable for unknown emails)                    |
| `POST /auth/register`          | no   | `RegisterPayload`           | `201 AuthResponse`; `409` if the email is taken                            |
| `POST /auth/login`             | no   | `LoginPayload`              | `AuthResponse` (`upgrade_required: true` for legacy accounts)              |
| `POST /auth/upgrade`           | yes  | `UpgradePayload`            | `AuthResponse` (legacy v1 → kdf_version 2)                                 |
| `GET /auth/me`                 | yes  | —                           | `MeResponse`                                                               |
| `POST /auth/change-password`   | yes  | `ChangePasswordPayload`     | `AuthResponse` with a new token; all other sessions end                    |
| `POST /auth/recovery-code`     | yes  | `RegenerateRecoveryPayload` | `{ message }`                                                              |
| `POST /auth/logout-all`        | yes  | —                           | `AuthResponse` with a new token; all other sessions end                    |
| `POST /auth/recovery-material` | no   | `RecoveryMaterialPayload`   | `RecoveryMaterialResponse` (fake but well-formed for unknown emails)       |
| `POST /auth/recover`           | no   | `RecoverPayload`            | `{ message }`; sets new password + new recovery code, revokes all sessions |

Key types:

```ts
type RegisterPayload = { email } & PasswordMaterial & RecoveryMaterial;
// PasswordMaterial: auth_key, salt, kdf_iterations, kdf_version: 2, encrypted_master_key, master_key_iv
// RecoveryMaterial: recovery_encrypted_master_key, recovery_key_iv, recovery_key_salt, recovery_key_hash

type LoginPayload = { email; auth_key } | { email; password }; // password only for kdf_version 1
type Credential = { auth_key } | { password }; // proof for sensitive operations

interface AuthResponse {
  token: string;
  user: PublicUser; // id, email, created_at, snapshot_retention, has_recovery_key, kdf_version
  crypto: CryptoParams; // kdf_version, kdf_iterations, salt, encrypted_master_key, master_key_iv
  upgrade_required?: boolean;
}

interface ChangePasswordPayload {
  current: Credential;
  next: PasswordMaterial;
}
interface RegenerateRecoveryPayload {
  current: Credential;
  recovery: RecoveryMaterial;
}
interface RecoverPayload {
  email;
  recovery_key_hash;
  next: PasswordMaterial;
  recovery: RecoveryMaterial;
}
```

## Devices

| Method & path                  | Auth | Body                    | Response                            |
| ------------------------------ | ---- | ----------------------- | ----------------------------------- |
| `POST /devices/register`       | yes  | `RegisterDevicePayload` | `201 DeviceResponse`                |
| `GET /devices`                 | yes  | —                       | `DevicesResponse`                   |
| `PATCH /devices/:id/heartbeat` | yes  | —                       | `{ ok: true }` (`404` if not yours) |
| `DELETE /devices/:id`          | yes  | —                       | `{ message }`                       |

`RegisterDevicePayload = { device_name, id? }`: an existing `id` is reused only if it belongs to the caller,
otherwise a new device is created.

## Account

| Method & path                 | Auth | Body                   | Response                                                                                        |
| ----------------------------- | ---- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /account`                | yes  | —                      | `AccountInfoResponse` (account + stats: device/snapshot/saved counts, storage bytes, last sync) |
| `PATCH /account/retention`    | yes  | `RetentionPayload`     | `{ retention }`                                                                                 |
| `GET /account/devices`        | yes  | —                      | `AccountDevicesResponse` (devices with `snapshot_count`, `last_snapshot_at`)                    |
| `PATCH /account/devices/:id`  | yes  | `{ device_name }`      | `DeviceResponse`                                                                                |
| `DELETE /account/devices/:id` | yes  | —                      | `{ message }`                                                                                   |
| `DELETE /account`             | yes  | `DeleteAccountPayload` | `{ message }`                                                                                   |

## Snapshots

| Method & path            | Auth | Body / query                 | Response                                                       |
| ------------------------ | ---- | ---------------------------- | -------------------------------------------------------------- |
| `POST /snapshots`        | yes  | `UploadSnapshotPayload`      | `201 UploadSnapshotResponse`                                   |
| `GET /snapshots/latest`  | yes  | —                            | `SnapshotsResponse` (newest per device)                        |
| `GET /snapshots/history` | yes  | `?device_id=&limit=&before=` | `SnapshotHistoryResponse` (newest first, cursor `next_before`) |
| `GET /snapshots/saved`   | yes  | —                            | `SnapshotsResponse` (pinned snapshots)                         |
| `GET /snapshots/:id`     | yes  | —                            | `{ snapshot: SnapshotWithDevice }`                             |
| `PATCH /snapshots/:id`   | yes  | `UpdateSnapshotPayload`      | `{ snapshot: SnapshotWithDevice }`                             |
| `DELETE /snapshots/:id`  | yes  | —                            | `{ message }`                                                  |

```ts
interface UploadSnapshotPayload {
  device_id: string;
  captured_at: string; // part of the AAD; must match what was encrypted
  iv: string;
  encrypted_blob: string; // <= LIMITS.maxSnapshotBlobChars
  enc_version: number; // 2
}
interface UpdateSnapshotPayload {
  pinned?: boolean;
  label_enc?: string | null;
  label_iv?: string | null;
}
```

Pinned snapshots ("saved sessions") are never pruned by retention.

## Restore / send tab

| Method & path          | Auth | Body / query             | Response                                                                                           |
| ---------------------- | ---- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `POST /restore`        | yes  | `CreateRestorePayload`   | `201 CreateRestoreResponse`                                                                        |
| `GET /restore/pending` | yes  | `?device_id=`            | `PendingRestoreResponse`                                                                           |
| `GET /restore/stream`  | yes  | `?device_id=`            | `text/event-stream`: each `data:` event is a `PendingRestoreResponse`; `: ping` comment every 20 s |
| `PATCH /restore/:id`   | yes  | `CompleteRestorePayload` | reported by the target device                                                                      |
| `GET /restore/:id`     | yes  | —                        | `RestoreStatusResponse`                                                                            |

```ts
interface CreateRestorePayload {
  target_device_id: string;
  snapshot_id?: string; // open a whole snapshot on the target, or
  encrypted_payload?: string; // an encrypted { urls } (crypto.encryptRestorePayload)
  payload_iv?: string;
}
interface CompleteRestorePayload {
  status: 'completed' | 'failed';
  error_code?:
    'master_key_missing' | 'decrypt_failed' | 'empty_snapshot' | 'unsafe_url' | 'open_failed' | 'unknown';
}
```

Request statuses: `pending`, `completed`, `failed`, `expired`. Pending requests expire (`expires_at`) and are
cleaned up by the backend's cleanup job.
