import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type UserVoiceSetting = {
  guildId: string;
  userId: string;
  preset: string;
};

export type GuildTtsChannelSetting = {
  guildId: string;
  channelId: string;
};

export type UserTtsEngineSetting = {
  guildId: string;
  userId: string;
  engine: string;
};

export interface VoiceSettingsStore {
  getUserVoicePreset(guildId: string, userId: string): string | undefined;
  setUserVoicePreset(guildId: string, userId: string, preset: string): void;
  getUserTtsEngine(guildId: string, userId: string): string | undefined;
  setUserTtsEngine(guildId: string, userId: string, engine: string | undefined): void;
  getWatchedChannelId(guildId: string): string | undefined;
  setWatchedChannelId(guildId: string, channelId: string | undefined): void;
  getCommandPrefix(guildId: string): string | undefined;
  setCommandPrefix(guildId: string, prefix: string | undefined): void;
  close?(): void;
}

export class SqliteVoiceSettingsStore implements VoiceSettingsStore {
  private readonly db: Database.Database;

  constructor(path = process.env.DATABASE_PATH ?? 'data/chococobot.sqlite3') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tts_voice_settings (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        preset TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS tts_watched_channels (
        guild_id TEXT NOT NULL PRIMARY KEY,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tts_engine_settings (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS guild_prefix_settings (
        guild_id TEXT NOT NULL PRIMARY KEY,
        prefix TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getUserVoicePreset(guildId: string, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT preset FROM tts_voice_settings WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as { preset: string } | undefined;
    return row?.preset;
  }

  setUserVoicePreset(guildId: string, userId: string, preset: string): void {
    this.db
      .prepare(
        `INSERT INTO tts_voice_settings (guild_id, user_id, preset, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id)
         DO UPDATE SET preset = excluded.preset, updated_at = excluded.updated_at`
      )
      .run(guildId, userId, preset, new Date().toISOString());
  }

  getUserTtsEngine(guildId: string, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT engine FROM tts_engine_settings WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as { engine: string } | undefined;
    return row?.engine;
  }

  setUserTtsEngine(guildId: string, userId: string, engine: string | undefined): void {
    if (!engine) {
      this.db.prepare('DELETE FROM tts_engine_settings WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO tts_engine_settings (guild_id, user_id, engine, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id)
         DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at`
      )
      .run(guildId, userId, engine, new Date().toISOString());
  }

  getWatchedChannelId(guildId: string): string | undefined {
    const row = this.db
      .prepare('SELECT channel_id FROM tts_watched_channels WHERE guild_id = ?')
      .get(guildId) as { channel_id: string } | undefined;
    return row?.channel_id;
  }

  setWatchedChannelId(guildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.db.prepare('DELETE FROM tts_watched_channels WHERE guild_id = ?').run(guildId);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO tts_watched_channels (guild_id, channel_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id)
         DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`
      )
      .run(guildId, channelId, new Date().toISOString());
  }

  getCommandPrefix(guildId: string): string | undefined {
    const row = this.db
      .prepare('SELECT prefix FROM guild_prefix_settings WHERE guild_id = ?')
      .get(guildId) as { prefix: string } | undefined;
    return row?.prefix;
  }

  setCommandPrefix(guildId: string, prefix: string | undefined): void {
    if (!prefix) {
      this.db.prepare('DELETE FROM guild_prefix_settings WHERE guild_id = ?').run(guildId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO guild_prefix_settings (guild_id, prefix, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id)
         DO UPDATE SET prefix = excluded.prefix, updated_at = excluded.updated_at`
      )
      .run(guildId, prefix, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

export class InMemoryVoiceSettingsStore implements VoiceSettingsStore {
  private readonly presets = new Map<string, string>();
  private readonly engines = new Map<string, string>();
  private readonly watchedChannels = new Map<string, string>();
  private readonly prefixes = new Map<string, string>();

  getUserVoicePreset(guildId: string, userId: string): string | undefined {
    return this.presets.get(keyFor(guildId, userId));
  }

  setUserVoicePreset(guildId: string, userId: string, preset: string): void {
    this.presets.set(keyFor(guildId, userId), preset);
  }

  getUserTtsEngine(guildId: string, userId: string): string | undefined {
    return this.engines.get(keyFor(guildId, userId));
  }

  setUserTtsEngine(guildId: string, userId: string, engine: string | undefined): void {
    if (!engine) {
      this.engines.delete(keyFor(guildId, userId));
      return;
    }
    this.engines.set(keyFor(guildId, userId), engine);
  }

  getWatchedChannelId(guildId: string): string | undefined {
    return this.watchedChannels.get(guildId);
  }

  setWatchedChannelId(guildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.watchedChannels.delete(guildId);
      return;
    }
    this.watchedChannels.set(guildId, channelId);
  }

  getCommandPrefix(guildId: string): string | undefined {
    return this.prefixes.get(guildId);
  }

  setCommandPrefix(guildId: string, prefix: string | undefined): void {
    if (!prefix) {
      this.prefixes.delete(guildId);
      return;
    }
    this.prefixes.set(guildId, prefix);
  }
}

function keyFor(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
