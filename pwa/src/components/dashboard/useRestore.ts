'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RESTORE_ERROR_MESSAGES, type Device, type RestoreErrorCode } from '@vaulttabs/shared';
import { encryptRestorePayload } from '@vaulttabs/shared/crypto';
import { api, errorMessage } from '@/lib/api';

export type RestoreTarget =
  { kind: 'tab'; url: string; title: string } | { kind: 'snapshot'; snapshotId: string; title: string };

export type RestoreState =
  | { phase: 'idle' }
  | { phase: 'sending'; deviceName: string; what: string }
  | { phase: 'waiting'; deviceName: string; what: string }
  | { phase: 'success'; deviceName: string; what: string }
  | { phase: 'error'; deviceName: string; message: string };

const POLL_MS = 2000;
const MAX_WAIT_MS = 3 * 60_000;

function messageFor(code: RestoreErrorCode | null): string {
  return RESTORE_ERROR_MESSAGES[code ?? 'unknown'] ?? RESTORE_ERROR_MESSAGES.unknown;
}

/** Create a restore request and poll GET /restore/:id until the target device reports back. */
export function useRestore(key: CryptoKey, userId: string) {
  const [state, setState] = useState<RestoreState>({ phase: 'idle' });
  const run = useRef(0);

  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  const start = useCallback(
    async (target: RestoreTarget, device: Device) => {
      const myRun = ++run.current;
      const alive = () => run.current === myRun;
      const what = target.kind === 'tab' ? 'tab' : 'tabs';
      setState({ phase: 'sending', deviceName: device.device_name, what });
      try {
        const payload =
          target.kind === 'tab'
            ? {
                target_device_id: device.id,
                ...(await encryptRestorePayload({ urls: [target.url] }, key, {
                  userId,
                  targetDeviceId: device.id,
                })),
              }
            : { target_device_id: device.id, snapshot_id: target.snapshotId };
        const created = await api.createRestore(payload);
        if (!alive()) return;
        setState({ phase: 'waiting', deviceName: device.device_name, what });

        const expiresAt = new Date(created.expires_at).getTime();
        const deadline =
          Date.now() +
          Math.min(
            MAX_WAIT_MS,
            Number.isFinite(expiresAt) ? Math.max(expiresAt - Date.now() + 5000, 10_000) : MAX_WAIT_MS,
          );

        while (alive()) {
          await new Promise(r => setTimeout(r, POLL_MS));
          if (!alive()) return;
          let status;
          try {
            status = (await api.restoreStatus(created.request_id)).request;
          } catch {
            if (Date.now() > deadline) break;
            continue; // transient network error: keep polling
          }
          if (!alive()) return;
          if (status.status === 'completed') {
            setState({ phase: 'success', deviceName: device.device_name, what });
            return;
          }
          if (status.status === 'failed') {
            setState({
              phase: 'error',
              deviceName: device.device_name,
              message: messageFor(status.error_code),
            });
            return;
          }
          if (status.status === 'expired' || Date.now() > deadline) break;
        }
        if (alive()) {
          setState({
            phase: 'error',
            deviceName: device.device_name,
            message: `${device.device_name} did not pick this up in time. Is that browser running with the VaultTabs extension signed in?`,
          });
        }
      } catch (err) {
        if (alive())
          setState({
            phase: 'error',
            deviceName: device.device_name,
            message: errorMessage(err, 'Could not send the request.'),
          });
      }
    },
    [key, userId],
  );

  const reset = useCallback(() => {
    run.current++;
    setState({ phase: 'idle' });
  }, []);

  return { state, start, reset };
}
