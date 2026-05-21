import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SqliteAiMemoryStore } from '../src/services/aiMemoryStore.js';

describe('AiMemoryStore', () => {
  it('stores turn metadata with user ids and resets per guild', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-memory-')), 'memory.sqlite3');
    const store = new SqliteAiMemoryStore(dbPath);

    store.appendTurn({
      guildId: 'g1',
      channelId: 'c1',
      userId: 'u1',
      userName: '홍길동',
      role: 'user',
      content: '안녕',
      importance: 0
    });
    store.appendTurn({
      guildId: 'g1',
      channelId: 'c1',
      userId: 'bot-1',
      userName: 'ChococoBot',
      role: 'assistant',
      content: '반가워요',
      importance: 0
    });

    const snapshot = store.getGuildSnapshot('g1', 8);
    expect(snapshot.unsummarizedCount).toBe(2);
    expect(snapshot.recentTurns[0]).toMatchObject({
      guildId: 'g1',
      channelId: 'c1',
      userId: 'u1',
      userName: '홍길동',
      role: 'user',
      content: '안녕'
    });
    expect(snapshot.recentTurns[1]).toMatchObject({
      role: 'assistant',
      content: '반가워요'
    });

    store.replaceSummaryAndMarkCompacted('g1', '요약');
    const compacted = store.getGuildSnapshot('g1', 8);
    expect(compacted.summary).toBe('요약');
    expect(compacted.unsummarizedCount).toBe(0);

    store.resetGuildMemory('g1');
    const reset = store.getGuildSnapshot('g1', 8);
    expect(reset.summary).toBe('');
    expect(reset.unsummarizedCount).toBe(0);
  });
});
