import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { WebSearchMode } from './webSearchService.js';

export type UserVoiceSetting = {
  guildId: string;
  userId: string;
  preset: string;
};

export type GuildTtsChannelSetting = {
  guildId: string;
  channelId: string;
};

export type GuildAiChannelSetting = {
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
  getAiChannelId(guildId: string): string | undefined;
  setAiChannelId(guildId: string, channelId: string | undefined): void;
  getCommandPrefix(guildId: string): string | undefined;
  setCommandPrefix(guildId: string, prefix: string | undefined): void;
  getGuildWebSearchMode(guildId: string): WebSearchMode | undefined;
  setGuildWebSearchMode(guildId: string, mode: WebSearchMode | undefined): void;
  getUserTimeZone(guildId: string, userId: string): string | undefined;
  setUserTimeZone(guildId: string, userId: string, timeZone: string | undefined): void;
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

      CREATE TABLE IF NOT EXISTS ai_chat_channels (
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

      CREATE TABLE IF NOT EXISTS guild_web_search_settings (
        guild_id TEXT NOT NULL PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_time_zone_settings (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
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

  getAiChannelId(guildId: string): string | undefined {
    const row = this.db
      .prepare('SELECT channel_id FROM ai_chat_channels WHERE guild_id = ?')
      .get(guildId) as { channel_id: string } | undefined;
    return row?.channel_id;
  }

  setAiChannelId(guildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.db.prepare('DELETE FROM ai_chat_channels WHERE guild_id = ?').run(guildId);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO ai_chat_channels (guild_id, channel_id, updated_at)
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

  getGuildWebSearchMode(guildId: string): WebSearchMode | undefined {
    const row = this.db
      .prepare('SELECT mode FROM guild_web_search_settings WHERE guild_id = ?')
      .get(guildId) as { mode: string } | undefined;
    return isWebSearchMode(row?.mode) ? row.mode : undefined;
  }

  setGuildWebSearchMode(guildId: string, mode: WebSearchMode | undefined): void {
    if (!mode) {
      this.db.prepare('DELETE FROM guild_web_search_settings WHERE guild_id = ?').run(guildId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO guild_web_search_settings (guild_id, mode, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id)
         DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`
      )
      .run(guildId, mode, new Date().toISOString());
  }

  getUserTimeZone(guildId: string, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT time_zone FROM user_time_zone_settings WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as { time_zone: string } | undefined;
    return row?.time_zone;
  }

  setUserTimeZone(guildId: string, userId: string, timeZone: string | undefined): void {
    if (!timeZone) {
      this.db.prepare('DELETE FROM user_time_zone_settings WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO user_time_zone_settings (guild_id, user_id, time_zone, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id)
         DO UPDATE SET time_zone = excluded.time_zone, updated_at = excluded.updated_at`
      )
      .run(guildId, userId, timeZone, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

export class InMemoryVoiceSettingsStore implements VoiceSettingsStore {
  private readonly presets = new Map<string, string>();
  private readonly engines = new Map<string, string>();
  private readonly watchedChannels = new Map<string, string>();
  private readonly aiChannels = new Map<string, string>();
  private readonly prefixes = new Map<string, string>();
  private readonly webSearchModes = new Map<string, WebSearchMode>();
  private readonly timeZones = new Map<string, string>();

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

  getAiChannelId(guildId: string): string | undefined {
    return this.aiChannels.get(guildId);
  }

  setAiChannelId(guildId: string, channelId: string | undefined): void {
    if (!channelId) {
      this.aiChannels.delete(guildId);
      return;
    }
    this.aiChannels.set(guildId, channelId);
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

  getGuildWebSearchMode(guildId: string): WebSearchMode | undefined {
    return this.webSearchModes.get(guildId);
  }

  setGuildWebSearchMode(guildId: string, mode: WebSearchMode | undefined): void {
    if (!mode) {
      this.webSearchModes.delete(guildId);
      return;
    }
    this.webSearchModes.set(guildId, mode);
  }

  getUserTimeZone(guildId: string, userId: string): string | undefined {
    return this.timeZones.get(keyFor(guildId, userId));
  }

  setUserTimeZone(guildId: string, userId: string, timeZone: string | undefined): void {
    if (!timeZone) {
      this.timeZones.delete(keyFor(guildId, userId));
      return;
    }
    this.timeZones.set(keyFor(guildId, userId), timeZone);
  }
}

function keyFor(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function isWebSearchMode(value: unknown): value is WebSearchMode {
  return value === 'disabled' || value === 'explicit_only' || value === 'automatic' || value === 'search_first_factual';
}
