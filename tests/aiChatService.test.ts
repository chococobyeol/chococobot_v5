import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { AiChatService, parseAiChatTrigger } from '../src/services/aiChatService.js';
import { InMemoryAiMemoryStore } from '../src/services/aiMemoryStore.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';
import type { Settings } from '../src/config.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeSettings(): Settings {
  return {
    discordToken: 'token',
    groqApiKey: 'test',
    groqModel: 'test-model',
    aiSystemPrompt: 'system',
    aiMaxCompletionTokens: 1000,
    aiPlannerMaxCompletionTokens: 300,
    aiUserDailyTokenLimit: 1000,
    aiGuildDailyTokenLimit: 1000,
    aiMemoryRecentTurns: 8,
    aiMemoryCompactAfterTurns: 99,
    aiMemoryMaxSummaryChars: 2000,
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
    logLevel: 'info'
  };
}

function makeMessage(channelId = 'channel-1', text = '!? 안녕') {
  const reply = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  return {
    id: `message-${channelId}`,
    guildId: 'guild-1',
    channelId,
    content: text,
    createdTimestamp: Date.parse('2026-05-22T18:15:00.000Z'),
    channel: {
      type: ChannelType.GuildText,
      send
    },
    guild: { name: '테스트서버' },
    author: {
      id: 'user-1',
      username: 'tester',
      bot: false
    },
    member: {
      displayName: '테스터'
    },
    client: {
      user: {
        id: 'bot-1',
        username: 'ChococoBot'
      }
    },
    reply,
    mentions: {
      channels: {
        first: vi.fn(() => null)
      }
    }
  } as any;
}

describe('parseAiChatTrigger', () => {
  it('accepts only <prefix>?<whitespace><prompt> forms', () => {
    expect(parseAiChatTrigger('!? 안녕', '!')).toBe('안녕');
    expect(parseAiChatTrigger('~?   안녕', '~')).toBe('안녕');
    expect(parseAiChatTrigger('?? hello', '?')).toBe('hello');
    expect(parseAiChatTrigger('!?', '!')).toBeNull();
    expect(parseAiChatTrigger('!?hello', '!')).toBeNull();
    expect(parseAiChatTrigger('! ? hello', '!')).toBeNull();
    expect(parseAiChatTrigger('  !? hello', '!')).toBeNull();
  });
});

describe('AiChatService', () => {
  it('keeps same-channel AI requests in FIFO order', async () => {
    const settings = makeSettings();
    const memory = new InMemoryAiMemoryStore();
    const first = deferred<string>();
    const second = deferred<string>();
    const ai = {
      askMessages: vi.fn()
        .mockImplementationOnce(async () => first.promise)
        .mockImplementationOnce(async () => second.promise)
    } as any;
    const activityLog = {
      logCommand: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined)
    } as any;
    const service = new AiChatService(settings, ai, memory, activityLog);
    const firstMessage = makeMessage('channel-1', '!? 첫번째');
    const secondMessage = makeMessage('channel-1', '!? 두번째');

    const firstTask = service.handlePrompt(firstMessage, '첫번째');
    const secondTask = service.handlePrompt(secondMessage, '두번째');

    await flushAsync();
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
    const firstCallMessages = ai.askMessages.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(firstCallMessages.some((message) => message.content.includes('작성자: 테스터 (user-1)'))).toBe(true);
    expect(firstCallMessages.some((message) => message.content.includes('채널: <#channel-1>'))).toBe(true);
    first.resolve('첫 답변');
    await firstTask;
    await flushAsync();
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    second.resolve('둘째 답변');
    await Promise.all([firstTask, secondTask]);

    expect(firstMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '첫 답변' })
    );
    expect(secondMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '둘째 답변' })
    );
    expect(memory.getGuildSnapshot('guild-1', 8).unsummarizedCount).toBe(4);
  });

  it('can process different-channel requests without waiting on one another', async () => {
    const settings = makeSettings();
    const memory = new InMemoryAiMemoryStore();
    const first = deferred<string>();
    const second = deferred<string>();
    const ai = {
      askMessages: vi.fn()
        .mockImplementationOnce(async () => first.promise)
        .mockImplementationOnce(async () => second.promise)
    } as any;
    const activityLog = {
      logCommand: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined)
    } as any;
    const service = new AiChatService(settings, ai, memory, activityLog);
    const firstMessage = makeMessage('channel-1', '!? 첫번째');
    const secondMessage = makeMessage('channel-2', '!? 두번째');

    const firstTask = service.handlePrompt(firstMessage, '첫번째');
    const secondTask = service.handlePrompt(secondMessage, '두번째');

    await flushAsync();
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    first.resolve('첫 답변');
    second.resolve('둘째 답변');
    await Promise.all([firstTask, secondTask]);
  });

  it('chunks long replies into discord-safe follow-ups', async () => {
    const settings = makeSettings();
    const memory = new InMemoryAiMemoryStore();
    const ai = {
      askMessages: vi.fn(async () => '가'.repeat(2100))
    } as any;
    const activityLog = {
      logCommand: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined)
    } as any;
    const service = new AiChatService(settings, ai, memory, activityLog);
    const message = makeMessage('channel-1', '!? 아주 긴 답변');

    await service.handlePrompt(message, '아주 긴 답변');

    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        allowedMentions: { parse: [], repliedUser: false }
      })
    );
    const firstReplyContent = (message.reply as any).mock.calls[0][0].content as string;
    expect(firstReplyContent.length).toBeLessThanOrEqual(1900);
    expect(message.channel.send).toHaveBeenCalledTimes(1);
    const followUpContent = ((message.channel as any).send as any).mock.calls[0][0].content as string;
    expect(followUpContent.length).toBeLessThanOrEqual(1900);
    expect((message.channel as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], repliedUser: false }
      })
    );
  });


  it('passes the message timestamp context to AI chat fallback without parsing time locally', async () => {
    const settings = makeSettings();
    const memory = new InMemoryAiMemoryStore();
    const ai = {
      askMessagesDetailed: vi.fn(async () => ({
        content: '그냥 있어요...',
        model: 'openai/gpt-oss-120b',
        usageScope: 'chat',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        rateLimitHeaders: {},
        status: 200
      }))
    } as any;
    const activityLog = {
      logCommand: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined),
      logAiDiagnostic: vi.fn(async () => undefined)
    } as any;
    const service = new AiChatService(settings, ai, memory, activityLog, new InMemoryVoiceSettingsStore());
    const message = makeMessage('channel-1', '!? 뭐해');

    await service.handlePrompt(message, '뭐해');

    expect(ai.askMessagesDetailed).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('<t:1779473700:t>')
        })
      ])
    }));
  });

  it('normalizes generic assistant punctuation into the bot command-response tone', async () => {
    const settings = makeSettings();
    const memory = new InMemoryAiMemoryStore();
    const ai = {
      askMessagesDetailed: vi.fn(async () => ({
        content: '안녕하세요! 어떤 도움이 필요하신가요? 😊',
        model: 'openai/gpt-oss-120b',
        usageScope: 'chat',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        rateLimitHeaders: {},
        status: 200
      }))
    } as any;
    const activityLog = {
      logCommand: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined),
      logAiDiagnostic: vi.fn(async () => undefined)
    } as any;
    const service = new AiChatService(settings, ai, memory, activityLog);
    const message = makeMessage('channel-1', '!? 안녕');

    await service.handlePrompt(message, '안녕');

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '안녕하세요...' })
    );
    expect(activityLog.logCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'ai-chat-response',
        summary: 'answer=안녕하세요...'
      })
    );
    expect(memory.getGuildSnapshot('guild-1', 8).recentTurns.at(-1)).toMatchObject({
      role: 'assistant',
      content: '안녕하세요...'
    });
  });
});
