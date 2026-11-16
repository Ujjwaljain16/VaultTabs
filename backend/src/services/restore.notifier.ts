// Cross-instance delivery of restore requests.
//
// Each process holds ONE `LISTEN vaulttabs_restore` connection (postgres.js reconnects it
// automatically) and fans notifications out to its local SSE connections through an
// EventEmitter keyed by target device id. Notifications carry ids only; each SSE connection
// re-reads the request from the database scoped to its own user.

import { EventEmitter } from 'node:events';
import type { Sql } from '../db/client.js';
import type { Logger } from '../logger.js';
import { RESTORE_CHANNEL } from '../repositories/restore.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RestoreListener = (requestId: string) => void;

export class RestoreNotifier {
  private readonly emitter = new EventEmitter();
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly log: Logger,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (this.unlisten) return;
    const meta = await this.sql.listen(RESTORE_CHANNEL, payload => this.dispatch(payload));
    this.unlisten = () => meta.unlisten();
  }

  async stop(): Promise<void> {
    const unlisten = this.unlisten;
    this.unlisten = null;
    this.emitter.removeAllListeners();
    if (unlisten) {
      await unlisten().catch((err: unknown) => this.log.warn({ err }, 'restore notifier: unlisten failed'));
    }
  }

  subscribe(deviceId: string, listener: RestoreListener): () => void {
    this.emitter.on(deviceId, listener);
    return () => this.emitter.off(deviceId, listener);
  }

  private dispatch(payload: string): void {
    try {
      const { id, d } = JSON.parse(payload) as { id?: unknown; d?: unknown };
      if (typeof id === 'string' && typeof d === 'string' && UUID_RE.test(id) && UUID_RE.test(d)) {
        this.emitter.emit(d, id);
      }
    } catch {
      this.log.warn('restore notifier: ignoring malformed notification');
    }
  }
}
