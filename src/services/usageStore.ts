import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

export type UsageSummary = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageRecord = {
  guildId: string;
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageScope?: 'chat' | 'summary';
  at?: Date;
};

export class UsageStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_scope TEXT NOT NULL DEFAULT 'chat',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrateUsageScopeColumn();
  }

  recordAiUsage(record: UsageRecord): void {
    const at = record.at ?? new Date();
    this.db
      .prepare(`
        INSERT INTO ai_usage (
          created_at, usage_date, guild_id, user_id, model, usage_scope,
          prompt_tokens, completion_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        at.toISOString(),
        at.toISOString().slice(0, 10),
        record.guildId,
        record.userId,
        record.model,
        record.usageScope ?? 'chat',
        record.promptTokens,
        record.completionTokens,
        record.totalTokens
      );
  }

  summarizeUser(guildId: string, userId: string, days = 1, today = new Date()): UsageSummary {
    const startDate = startDateIso(days, today);
    return this.summary('guild_id = ? AND user_id = ? AND usage_scope = ? AND usage_date >= ?', [
      guildId,
      userId,
      'chat',
      startDate
    ]);
  }

  summarizeGuild(guildId: string, days = 1, today = new Date()): UsageSummary {
    const startDate = startDateIso(days, today);
    return this.summary('guild_id = ? AND usage_date >= ?', [guildId, startDate]);
  }

  close(): void {
    this.db.close();
  }

  private summary(where: string, params: unknown[]): UsageSummary {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as requests,
                COALESCE(SUM(prompt_tokens), 0) as promptTokens,
                COALESCE(SUM(completion_tokens), 0) as completionTokens,
                COALESCE(SUM(total_tokens), 0) as totalTokens
         FROM ai_usage
         WHERE ${where}`
      )
      .get(...params) as UsageSummary;
    return {
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens)
    };
  }

  private migrateUsageScopeColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(ai_usage)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'usage_scope')) {
      this.db.prepare(`ALTER TABLE ai_usage ADD COLUMN usage_scope TEXT NOT NULL DEFAULT 'chat'`).run();
    }
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage(guild_id, user_id, usage_date, usage_scope)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_usage_guild_date ON ai_usage(guild_id, usage_date)`).run();
  }
}

function startDateIso(days: number, today: Date): string {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - Math.max(1, days) + 1);
  return start.toISOString().slice(0, 10);
}
