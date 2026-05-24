import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertRuntimeSettings, type Settings } from '../src/config.js';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    discordToken: '',
    groqApiKey: '',
    groqModel: 'openai/gpt-oss-120b',
    aiSystemPrompt: 'test',
    aiMaxCompletionTokens: 500,
    aiPlannerMaxCompletionTokens: 800,
    aiUserDailyTokenLimit: 0,
    aiGuildDailyTokenLimit: 180000,
    aiMemoryRecentTurns: 4,
    aiMemoryCompactAfterTurns: 12,
    aiMemoryMaxSummaryChars: 900,
    webSearchEnabled: true,
    webSearchProvider: 'searxng',
    webSearchBaseUrl: 'http://127.0.0.1:8888',
    webSearchTimeoutMs: 5000,
    webSearchResultCount: 3,
    webSearchDefaultMode: 'search_first_factual',
    botTimeZone: 'Asia/Seoul',
    cleanMineDefaultTarget: 500,
    cleanMineMaxLimit: 500,
    cleanAllDefaultTarget: 1000,
    cleanAllMaxLimit: 1000,
    databasePath: 'data/test.sqlite3',
    loggingGuildId: '1507058598423826533',
    voiceIdleLeaveMs: 600000,
    ttsEngine: 'edge',
    ttsVoice: 'ko-KR-SunHiNeural',
    ttsMaxChars: 500,
    ttsReadBotMessages: false,
    ttsVoicePresets: {},
    logLevel: 'info',
    ...overrides
  };
}

describe('assertRuntimeSettings', () => {
  it('requires DISCORD_TOKEN by default', () => {
    expect(() => assertRuntimeSettings(makeSettings())).toThrow(/DISCORD_TOKEN/);
  });

  it('allows smoke mode validation without DISCORD_TOKEN', () => {
    expect(() => assertRuntimeSettings(makeSettings(), { requireDiscordToken: false })).not.toThrow();
  });
});


describe('deployment prompt defaults', () => {
  it('does not instruct deployed prompts to append polite suffixes', () => {
    const deploymentConfig = readFileSync('render.yaml', 'utf8');
    const envExample = readFileSync('.env.example', 'utf8');
    for (const content of [deploymentConfig, envExample]) {
      expect(content).not.toContain('문장 끝은 보통 ... 또는 해요로 마무리해요');
      expect(content).not.toContain('... 또는 해요');
      expect(content).toContain('접미어처럼 덧붙이지 않아요');
    }
  });
});
