import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
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

  it('counts summary usage for the guild but not for the requesting user', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-usage-')), 'usage.sqlite3');
    const store = new UsageStore(dbPath);
    store.recordAiUsage({
      guildId: 'g1',
      userId: '__maintenance__',
      model: 'm',
      usageScope: 'summary',
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      at: new Date('2026-05-20T00:00:00Z')
    });

    expect(store.summarizeUser('g1', '__maintenance__', 1, new Date('2026-05-20T12:00:00Z')).totalTokens).toBe(0);
    expect(store.summarizeGuild('g1', 1, new Date('2026-05-20T12:00:00Z')).totalTokens).toBe(10);
    store.close();
  });

  it('migrates older databases that do not have usage_scope yet', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-usage-migrate-')), 'usage.sqlite3');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO ai_usage (
        created_at, usage_date, guild_id, user_id, model,
        prompt_tokens, completion_tokens, total_tokens
      ) VALUES (
        '2026-05-20T00:00:00.000Z', '2026-05-20', 'g1', 'u1', 'm',
        5, 5, 10
      );
    `);
    legacyDb.close();

    const store = new UsageStore(dbPath);
    expect(store.summarizeGuild('g1', 1, new Date('2026-05-20T12:00:00Z')).totalTokens).toBe(10);
    store.recordAiUsage({
      guildId: 'g1',
      userId: 'u1',
      model: 'm',
      usageScope: 'chat',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2
    });
    expect(store.summarizeUser('g1', 'u1', 1, new Date('2026-05-20T12:00:00Z')).totalTokens).toBe(12);
    store.close();
  });
});
