import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { UsageStore } from '../src/services/usageStore.js';

describe('UsageStore', () => {
  it('records and summarizes user usage', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-usage-')), 'usage.sqlite3');
    const store = new UsageStore(dbPath);
    store.recordAiUsage({
      guildId: 'g1',
      userId: 'u1',
      model: 'm',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      at: new Date('2026-05-20T00:00:00Z')
    });
    store.recordAiUsage({
      guildId: 'g1',
      userId: 'u2',
      model: 'm',
      promptTokens: 9,
      completionTokens: 1,
      totalTokens: 10,
      at: new Date('2026-05-20T00:00:00Z')
    });

    expect(store.summarizeUser('g1', 'u1', 1, new Date('2026-05-20T12:00:00Z'))).toEqual({
      requests: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });
    expect(store.summarizeGuild('g1', 1, new Date('2026-05-20T12:00:00Z')).totalTokens).toBe(25);
    store.close();
  });
});
