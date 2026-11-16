// Delivery of restore requests to connected SSE clients.
//
// - The instance that creates a request publishes it locally right away (works everywhere,
//   including behind a transaction pooler where LISTEN is impossible).
// - For multi-instance deployments, each process also holds ONE `LISTEN vaulttabs_restore`
//   session (on the main pool if DATABASE_URL is direct, or on DATABASE_LISTEN_URL), so other
//   instances hear about it too. Notifications carry ids only; each SSE connection re-reads the
//   request from the database scoped to its own user.
// - Both paths can fire for the same request, so delivery is de-duplicated by request id.

import { EventEmitter } from 'node:events';
import type { Config } from '../config.js';
import { createSql, type Sql } from '../db/client.js';
import type { Logger } from '../logger.js';
import { RESTORE_CHANNEL } from '../repositories/restore.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // longer than a request's lifetime

export type RestoreListener = (requestId: string) => void;

export class RestoreNotifier {
  private readonly emitter = new EventEmitter();
  private readonly delivered = new Map<string, number>();
  private unlisten: (() => Promise<void>) | null = null;
  private listenSql: Sql | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly log: Logger,
    private readonly config: Pick<Config, 'restoreListen' | 'databaseSsl'>,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (this.unlisten) return;
    const mode = this.config.restoreListen;
    if (mode === 'off') {
      this.log.info(
        'restore delivery: local only (DATABASE_URL is a transaction pooler; set DATABASE_LISTEN_URL to a direct connection for multi-instance delivery)',
      );
      return;
    }
    let target = this.sql;
    if (mode !== 'main') {
      this.listenSql = createSql(
        { databaseUrl: mode.url, databaseSsl: this.config.databaseSsl, databasePoolMax: 1 },
        { max: 1 },
      );
      target = this.listenSql;
    }
    const meta = await target.listen(RESTORE_CHANNEL, payload => this.onNotification(payload));
    this.unlisten = () => meta.unlisten();
    this.log.info({ mode: mode === 'main' ? 'main' : 'dedicated' }, 'restore delivery: LISTEN active');
  }

  async stop(): Promise<void> {
    const unlisten = this.unlisten;
    this.unlisten = null;
    this.emitter.removeAllListeners();
    if (unlisten) {
      await unlisten().catch((err: unknown) => this.log.warn({ err }, 'restore notifier: unlisten failed'));
    }
    if (this.listenSql) {
      await this.listenSql.end({ timeout: 5 }).catch(() => {});
      this.listenSql = null;
    }
  }

  subscribe(deviceId: string, listener: RestoreListener): () => void {
    const key = deviceId.toLowerCase();
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  /** Called by the instance that created the request (after commit). */
  publish(requestId: string, targetDeviceId: string): void {
    this.dispatch(requestId, targetDeviceId);
  }

  private onNotification(payload: string): void {
    try {
      const { id, d } = JSON.parse(payload) as { id?: unknown; d?: unknown };
      if (typeof id === 'string' && typeof d === 'string') this.dispatch(id, d);
    } catch {
      this.log.warn('restore notifier: ignoring malformed notification');
    }
  }

  private dispatch(id: string, deviceId: string): void {
    if (!UUID_RE.test(id) || !UUID_RE.test(deviceId)) return;
    const now = Date.now();
    for (const [seen, at] of this.delivered) {
      if (now - at > DEDUPE_WINDOW_MS) this.delivered.delete(seen);
      else break; // Map keeps insertion order, so the rest are newer
    }
    const key = id.toLowerCase();
    if (this.delivered.has(key)) return;
    this.delivered.set(key, now);
    this.emitter.emit(deviceId.toLowerCase(), key);
  }
}
