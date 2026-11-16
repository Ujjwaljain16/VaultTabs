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
  /** Not picked up yet: that browser is closed. It stays queued (24 h) and opens when it starts. */
  | { phase: 'queued'; deviceName: string; what: string }
  | { phase: 'error'; deviceName: string; message: string };

const POLL_MS = 2000;
/** After this long without a pick-up, report "queued" instead of waiting on. */
const QUEUED_AFTER_MS = 12_000;

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

        const deadline = Date.now() + QUEUED_AFTER_MS;

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
          if (status.status === 'expired') {
            setState({
              phase: 'error',
              deviceName: device.device_name,
              message: `The request expired before ${device.device_name} picked it up.`,
            });
            return;
          }
          if (Date.now() > deadline) break;
        }
        if (alive()) setState({ phase: 'queued', deviceName: device.device_name, what });
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
