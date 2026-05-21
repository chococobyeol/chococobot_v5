import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type AiMemoryRole = 'user' | 'assistant';

export type AiMemoryTurn = {
  id: number;
  guildId: string;
  channelId: string;
  userId: string;
  userName: string;
  messageId?: string | null;
  role: AiMemoryRole;
  content: string;
  importance: number;
  includedInSummary: boolean;
  createdAt: string;
};

export type AiMemorySnapshot = {
  summary: string;
  version: number;
  recentTurns: AiMemoryTurn[];
  unsummarizedCount: number;
  unsummarizedChars: number;
};

export type AppendTurnInput = Omit<AiMemoryTurn, 'id' | 'includedInSummary' | 'createdAt'> & {
  messageId?: string | null;
  createdAt?: Date;
  includedInSummary?: boolean;
};

export interface AiMemoryStore {
  getGuildSnapshot(guildId: string, recentLimit: number): AiMemorySnapshot;
  appendTurn(turn: AppendTurnInput): void;
  replaceSummaryAndMarkCompacted(guildId: string, summary: string): void;
  resetGuildMemory(guildId: string): void;
  close?(): void;
}

export class SqliteAiMemoryStore implements AiMemoryStore {
  private readonly db: Database.Database;

  constructor(path = process.env.DATABASE_PATH ?? 'data/chococobot.sqlite3') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_memory_summaries (
        guild_id TEXT NOT NULL PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS ai_memory_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        message_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 0,
        included_in_summary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_memory_turns_summary ON ai_memory_turns(guild_id, included_in_summary, id);
      CREATE INDEX IF NOT EXISTS idx_ai_memory_turns_channel_time ON ai_memory_turns(guild_id, channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_memory_turns_time ON ai_memory_turns(guild_id, created_at);
    `);
  }

  getGuildSnapshot(guildId: string, recentLimit: number): AiMemorySnapshot {
    const summaryRow = this.db
      .prepare('SELECT summary, version FROM ai_memory_summaries WHERE guild_id = ?')
      .get(guildId) as { summary: string; version: number } | undefined;
    const recentTurns = this.db
      .prepare(
        `
        SELECT id, guild_id as guildId, channel_id as channelId, user_id as userId, user_name as userName,
               message_id as messageId, role, content, importance, included_in_summary as includedInSummary, created_at as createdAt
        FROM ai_memory_turns
        WHERE guild_id = ? AND included_in_summary = 0
        ORDER BY id DESC
        LIMIT ?
        `
      )
      .all(guildId, recentLimit) as AiMemoryTurn[];
    const aggregate = this.db
      .prepare(
        `
        SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(content)), 0) as chars
        FROM ai_memory_turns
        WHERE guild_id = ? AND included_in_summary = 0
        `
      )
      .get(guildId) as { count: number; chars: number };
    return {
      summary: summaryRow?.summary ?? '',
      version: summaryRow?.version ?? 0,
      recentTurns: [...recentTurns].reverse(),
      unsummarizedCount: Number(aggregate.count),
      unsummarizedChars: Number(aggregate.chars)
    };
  }

  appendTurn(turn: AppendTurnInput): void {
    const at = turn.createdAt ?? new Date();
    this.db
      .prepare(
        `
        INSERT INTO ai_memory_turns (
          guild_id, channel_id, user_id, user_name, message_id, role,
          content, importance, included_in_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        turn.guildId,
        turn.channelId,
        turn.userId,
        turn.userName,
        turn.messageId ?? null,
        turn.role,
        turn.content,
        turn.importance,
        turn.includedInSummary ? 1 : 0,
        at.toISOString()
      );
  }

  replaceSummaryAndMarkCompacted(guildId: string, summary: string): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT version FROM ai_memory_summaries WHERE guild_id = ?')
      .get(guildId) as { version: number } | undefined;
    const nextVersion = (existing?.version ?? 0) + 1;
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO ai_memory_summaries (guild_id, summary, updated_at, version)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(guild_id)
          DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at, version = excluded.version
          `
        )
        .run(guildId, summary, now, nextVersion);
      this.db.prepare('UPDATE ai_memory_turns SET included_in_summary = 1 WHERE guild_id = ? AND included_in_summary = 0').run(guildId);
    });
    transaction();
  }

  resetGuildMemory(guildId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM ai_memory_summaries WHERE guild_id = ?').run(guildId);
      this.db.prepare('DELETE FROM ai_memory_turns WHERE guild_id = ?').run(guildId);
    });
    transaction();
  }

  close(): void {
    this.db.close();
  }
}

export class InMemoryAiMemoryStore implements AiMemoryStore {
  private readonly summaries = new Map<string, { summary: string; version: number }>();
  private readonly turns: AiMemoryTurn[] = [];
  private nextId = 1;

  getGuildSnapshot(guildId: string, recentLimit: number): AiMemorySnapshot {
    const summary = this.summaries.get(guildId);
    const unsummarized = this.turns.filter((turn) => turn.guildId === guildId && !turn.includedInSummary);
    return {
      summary: summary?.summary ?? '',
      version: summary?.version ?? 0,
      recentTurns: unsummarized.slice(-recentLimit),
      unsummarizedCount: unsummarized.length,
      unsummarizedChars: unsummarized.reduce((sum, turn) => sum + turn.content.length, 0)
    };
  }

  appendTurn(turn: AppendTurnInput): void {
    this.turns.push({
      id: this.nextId++,
      guildId: turn.guildId,
      channelId: turn.channelId,
      userId: turn.userId,
      userName: turn.userName,
      messageId: turn.messageId ?? null,
      role: turn.role,
      content: turn.content,
      importance: turn.importance,
      includedInSummary: turn.includedInSummary ?? false,
      createdAt: (turn.createdAt ?? new Date()).toISOString()
    });
  }

  replaceSummaryAndMarkCompacted(guildId: string, summary: string): void {
    const existing = this.summaries.get(guildId);
    this.summaries.set(guildId, { summary, version: (existing?.version ?? 0) + 1 });
    for (const turn of this.turns) {
      if (turn.guildId === guildId && !turn.includedInSummary) turn.includedInSummary = true;
    }
  }

  resetGuildMemory(guildId: string): void {
    this.summaries.delete(guildId);
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index].guildId === guildId) this.turns.splice(index, 1);
    }
  }
}
