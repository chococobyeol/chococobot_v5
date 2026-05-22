import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface BotActivityLogStore {
  getLogChannelId(sourceGuildId: string): string | undefined;
  setLogChannelId(sourceGuildId: string, channelId: string | undefined): void;
  clearLogChannels?(): void;
  close?(): void;
}

export class SqliteBotActivityLogStore implements BotActivityLogStore {
  private readonly db: Database.Database;

  constructor(path = process.env.DATABASE_PATH ?? 'data/chococobot.sqlite3') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_log_channels (
        source_guild_id TEXT NOT NULL PRIMARY KEY,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getLogChannelId(sourceGuildId: string): string | undefined {
    const row = this.db
      .prepare('SELECT channel_id FROM bot_log_channels WHERE source_guild_id = ?')
      .get(sourceGuildId) as { channel_id: string } | undefined;
    return row?.channel_id;
  }

  setLogChannelId(sourceGuildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.db.prepare('DELETE FROM bot_log_channels WHERE source_guild_id = ?').run(sourceGuildId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO bot_log_channels (source_guild_id, channel_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source_guild_id)
         DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`
      )
      .run(sourceGuildId, channelId, new Date().toISOString());
  }

  clearLogChannels(): void {
    this.db.prepare('DELETE FROM bot_log_channels').run();
  }

  close(): void {
    this.db.close();
  }
}

export class InMemoryBotActivityLogStore implements BotActivityLogStore {
  private readonly channels = new Map<string, string>();

  getLogChannelId(sourceGuildId: string): string | undefined {
    return this.channels.get(sourceGuildId);
  }

  setLogChannelId(sourceGuildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.channels.delete(sourceGuildId);
      return;
    }
    this.channels.set(sourceGuildId, channelId);
  }

  clearLogChannels(): void {
    this.channels.clear();
  }
}
