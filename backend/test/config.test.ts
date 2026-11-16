import { describe, expect, it } from 'vitest';
import { isTransactionPooler } from '../src/config.js';
import { testConfig } from './helpers.js';

describe('restore delivery mode', () => {
  it('detects transaction poolers where LISTEN cannot work', () => {
    expect(isTransactionPooler('postgresql://u:p@ep-x-123-pooler.c-4.us-east-1.aws.neon.tech/db')).toBe(true);
    expect(isTransactionPooler('postgres://u:p@db.internal:6432/db')).toBe(true);
    expect(isTransactionPooler('postgres://u:p@db.internal:5432/db?pgbouncer=true')).toBe(true);
    expect(isTransactionPooler('postgresql://u:p@ep-x-123.c-4.us-east-1.aws.neon.tech/db')).toBe(false);
    expect(isTransactionPooler('postgres://postgres@127.0.0.1:5432/db')).toBe(false);
  });

  it('uses LISTEN on the main pool for direct URLs and a dedicated URL when given', () => {
    expect(testConfig().restoreListen).toBe('main');
    expect(testConfig({ DATABASE_LISTEN_URL: 'postgres://direct.example/db' }).restoreListen).toEqual({
      url: 'postgres://direct.example/db',
    });
  });
});
