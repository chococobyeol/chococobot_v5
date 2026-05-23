import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { InMemoryVoiceSettingsStore, SqliteVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';
import { TtsService } from '../src/services/ttsService.js';
import { VoiceService } from '../src/services/voiceService.js';

const presets = {
  sunhi: 'ko-KR-SunHiNeural',
  injoon: 'ko-KR-InJoonNeural'
};

describe('VoiceSettingsStore', () => {
  it('persists per-guild per-user voice presets in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setUserVoicePreset('guild-1', 'user-1', 'sunhi');
    store.setUserVoicePreset('guild-2', 'user-1', 'injoon');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getUserVoicePreset('guild-1', 'user-1')).toBe('sunhi');
    expect(reopened.getUserVoicePreset('guild-2', 'user-1')).toBe('injoon');
    expect(reopened.getUserVoicePreset('guild-1', 'user-2')).toBeUndefined();
    reopened.close();
  });

  it('persists per-guild per-user tts engines in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setUserTtsEngine('guild-1', 'user-1', 'gtts');
    store.setUserTtsEngine('guild-2', 'user-1', 'edge');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getUserTtsEngine('guild-1', 'user-1')).toBe('gtts');
    expect(reopened.getUserTtsEngine('guild-2', 'user-1')).toBe('edge');
    reopened.setUserTtsEngine('guild-1', 'user-1', undefined);
    expect(reopened.getUserTtsEngine('guild-1', 'user-1')).toBeUndefined();
    reopened.close();
  });

  it('persists watched TTS channels in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setWatchedChannelId('guild-1', 'channel-1');
    store.setWatchedChannelId('guild-2', 'channel-2');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getWatchedChannelId('guild-1')).toBe('channel-1');
    expect(reopened.getWatchedChannelId('guild-2')).toBe('channel-2');
    reopened.setWatchedChannelId('guild-1', undefined);
    expect(reopened.getWatchedChannelId('guild-1')).toBeUndefined();
    reopened.close();
  });

  it('persists AI chat channels in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setAiChannelId('guild-1', 'channel-1');
    store.setAiChannelId('guild-2', 'channel-2');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getAiChannelId('guild-1')).toBe('channel-1');
    expect(reopened.getAiChannelId('guild-2')).toBe('channel-2');
    reopened.setAiChannelId('guild-1', undefined);
    expect(reopened.getAiChannelId('guild-1')).toBeUndefined();
    reopened.close();
  });

  it('persists guild prefixes in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setCommandPrefix('guild-1', '?');
    store.setCommandPrefix('guild-2', '.');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getCommandPrefix('guild-1')).toBe('?');
    expect(reopened.getCommandPrefix('guild-2')).toBe('.');
    reopened.setCommandPrefix('guild-1', undefined);
    expect(reopened.getCommandPrefix('guild-1')).toBeUndefined();
    reopened.close();
  });

  it('persists guild web search modes in sqlite and memory stores', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setGuildWebSearchMode('guild-1', 'explicit_only');
    store.setGuildWebSearchMode('guild-2', 'disabled');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getGuildWebSearchMode('guild-1')).toBe('explicit_only');
    expect(reopened.getGuildWebSearchMode('guild-2')).toBe('disabled');
    reopened.setGuildWebSearchMode('guild-1', undefined);
    expect(reopened.getGuildWebSearchMode('guild-1')).toBeUndefined();
    reopened.close();

    const memory = new InMemoryVoiceSettingsStore();
    memory.setGuildWebSearchMode('guild-1', 'automatic');
    expect(memory.getGuildWebSearchMode('guild-1')).toBe('automatic');
    memory.setGuildWebSearchMode('guild-1', undefined);
    expect(memory.getGuildWebSearchMode('guild-1')).toBeUndefined();
  });

  it('persists per-guild per-user time zones in sqlite', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'chococo-voice-')), 'voice.sqlite3');
    const store = new SqliteVoiceSettingsStore(dbPath);
    store.setUserTimeZone('guild-1', 'user-1', 'America/Los_Angeles');
    store.setUserTimeZone('guild-2', 'user-1', 'Asia/Seoul');
    store.close();

    const reopened = new SqliteVoiceSettingsStore(dbPath);
    expect(reopened.getUserTimeZone('guild-1', 'user-1')).toBe('America/Los_Angeles');
    expect(reopened.getUserTimeZone('guild-2', 'user-1')).toBe('Asia/Seoul');
    reopened.setUserTimeZone('guild-1', 'user-1', undefined);
    expect(reopened.getUserTimeZone('guild-1', 'user-1')).toBeUndefined();
    reopened.close();
  });

});

describe('VoiceService voice presets', () => {
  it('validates and stores presets per guild/user without cross-guild leakage', () => {
    const store = new InMemoryVoiceSettingsStore();
    const service = new VoiceService(new TtsService('ko-KR-SunHiNeural', 180), store, presets, 'edge', 1_000);

    expect(service.listVoicePresets()).toEqual(['injoon', 'sunhi']);
    service.setUserVoicePreset('guild-1', 'user-1', 'sunhi');
    service.setUserVoicePreset('guild-2', 'user-1', 'injoon');

    expect(service.getUserVoicePreset('guild-1', 'user-1')).toBe('sunhi');
    expect(service.getUserVoicePreset('guild-2', 'user-1')).toBe('injoon');
    expect(() => service.setUserVoicePreset('guild-1', 'user-1', 'missing')).toThrow(/알 수 없는 음색/);
  });

  it('persists watched TTS channels per guild without cross-guild leakage', () => {
    const store = new InMemoryVoiceSettingsStore();
    const service = new VoiceService(new TtsService('ko-KR-SunHiNeural', 180), store, presets, 'edge', 1_000);

    service.setWatchedChannel('guild-1', 'channel-1', true);
    service.setWatchedChannel('guild-2', 'channel-2', true);

    expect(service.getWatchedChannelId('guild-1')).toBe('channel-1');
    expect(service.getWatchedChannelId('guild-2')).toBe('channel-2');

    service.setWatchedChannel('guild-1', 'channel-1', false);
    expect(service.getWatchedChannelId('guild-1')).toBeUndefined();
    expect(service.getWatchedChannelId('guild-2')).toBe('channel-2');
  });

  it('persists tts engines per guild/user without cross-guild leakage', () => {
    const store = new InMemoryVoiceSettingsStore();
    const service = new VoiceService(new TtsService('ko-KR-SunHiNeural', 180), store, presets, 'edge', 1_000);

    service.setUserTtsEngine('guild-1', 'user-1', 'gtts');
    service.setUserTtsEngine('guild-2', 'user-1', 'edge');

    expect(service.getUserTtsEngine('guild-1', 'user-1')).toBe('gtts');
    expect(service.getUserTtsEngine('guild-2', 'user-1')).toBe('edge');

    service.clearUserTtsEngine('guild-1', 'user-1');
    expect(service.getUserTtsEngine('guild-1', 'user-1')).toBe('edge');
    expect(service.getUserTtsEngine('guild-2', 'user-1')).toBe('edge');
  });
});
