import { describe, expect, it, vi } from 'vitest';
import { AiLimitError, AiService } from '../src/services/aiService.js';
import type { Settings } from '../src/config.js';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    discordToken: 'token',
    groqApiKey: 'test',
    groqModel: 'openai/gpt-oss-120b',
    aiSystemPrompt: 'system',
    aiMaxCompletionTokens: 500,
    aiPlannerMaxCompletionTokens: 300,
    aiUserDailyTokenLimit: 0,
    aiGuildDailyTokenLimit: 180_000,
    aiMemoryRecentTurns: 4,
    aiMemoryCompactAfterTurns: 12,
    aiMemoryMaxSummaryChars: 900,
    aiConfirmOwnCleanup: false,
    webSearchEnabled: true,
    webSearchProvider: 'searxng',
    webSearchBaseUrl: '',
    webSearchTimeoutMs: 5000,
    webSearchResultCount: 3,
    webSearchDefaultMode: 'search_first_factual',
    botTimeZone: 'Asia/Seoul',
    cleanMineDefaultTarget: 500,
    cleanMineMaxLimit: 500,
    cleanAllDefaultTarget: 1000,
    cleanAllMaxLimit: 1000,
    databasePath: ':memory:',
    loggingGuildId: 'log-guild',
    voiceIdleLeaveMs: 1000,
    ttsEngine: 'edge',
    ttsVoice: 'ko-KR-SunHiNeural',
    ttsMaxChars: 500,
    ttsReadBotMessages: false,
    ttsVoicePresets: {},
    logLevel: 'info',
    ...overrides
  };
}

describe('AiService internal token limits', () => {
  it('does not apply a per-user quota when AI_USER_DAILY_TOKEN_LIMIT is zero', async () => {
    const usageStore = {
      summarizeGuild: vi.fn(() => ({ requests: 1, promptTokens: 1, completionTokens: 1, totalTokens: 1 })),
      summarizeUser: vi.fn(() => ({ requests: 99, promptTokens: 99_999, completionTokens: 99_999, totalTokens: 199_998 })),
      recordAiUsage: vi.fn()
    };
    const service = new AiService(makeSettings({ aiUserDailyTokenLimit: 0 }), usageStore as any);
    const create = vi.fn(() => ({
      withResponse: vi.fn(async () => ({
        data: {
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: '안녕하세요...' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        },
        response: new Response(null, { status: 200, headers: { 'x-ratelimit-remaining-tokens': '7987' } })
      }))
    }));
    (service as any).groq = { chat: { completions: { create } } };

    await expect(service.askMessagesDetailed({
      guildId: 'guild-1',
      userId: 'user-1',
      messages: [{ role: 'user', content: '안녕' }]
    })).resolves.toMatchObject({ content: '안녕하세요...', totalTokens: 13 });

    expect(usageStore.summarizeUser).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_completion_tokens: 500 }));
  });

  it('describes the internal guild quota as a bot token limit, not a personal AI token limit', async () => {
    const usageStore = {
      summarizeGuild: vi.fn(() => ({ requests: 1000, promptTokens: 180_000, completionTokens: 0, totalTokens: 180_000 })),
      summarizeUser: vi.fn(() => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })),
      recordAiUsage: vi.fn()
    };
    const service = new AiService(makeSettings(), usageStore as any);

    await expect(service.askMessagesDetailed({
      guildId: 'guild-1',
      userId: 'user-1',
      messages: [{ role: 'user', content: '안녕' }]
    })).rejects.toThrow(new AiLimitError('오늘 봇 AI 토큰 한도를 거의 다 썼어요... 내일 다시 시도하거나 한도를 조정해 주세요.'));
  });
});
