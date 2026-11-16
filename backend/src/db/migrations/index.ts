import type { TransactionSql } from '../client.js';
import { baseline } from './001_baseline.js';
import { v2 } from './002_v2.js';

export interface Migration {
  /** Unique, sortable id; recorded in schema_migrations. Never rename or edit an applied one. */
  id: string;
  up(tx: TransactionSql): Promise<void>;
}

/** In order. Append new migrations; never reorder. */
export const migrations: readonly Migration[] = [baseline, v2];
