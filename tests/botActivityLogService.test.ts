import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { BotActivityLogService } from '../src/services/botActivityLogService.js';
import { InMemoryBotActivityLogStore } from '../src/services/botActivityLogStore.js';

describe('BotActivityLogService.logAiDiagnostic', () => {
  it('logs bounded AI diagnostic fields and whitelisted headers', async () => {
    const send = vi.fn(async () => undefined);
    const logChannel = { id: 'log-channel', type: ChannelType.GuildText, name: 'LOG-source', topic: 'Source guild: source (guild-1)', send };
    const sourceChannel = { id: 'channel-1', type: ChannelType.GuildText, name: 'general' };
    const loggingGuild = {
      id: 'log-guild',
      name: 'log',
      channels: {
        fetch: vi.fn(async (id?: string) => (id === 'log-channel' ? logChannel : null)),
        create: vi.fn(async () => logChannel),
        cache: new Map()
      }
    };
    const sourceGuild = {
      id: 'guild-1',
      name: 'source',
      channels: {
        fetch: vi.fn(async (id?: string) => (id === 'channel-1' ? sourceChannel : null)),
        cache: new Map([['channel-1', sourceChannel]])
      }
    };
    const client = {
      guilds: {
        fetch: vi.fn(async (id?: string) => (id === 'log-guild' ? loggingGuild : sourceGuild))
      }
    } as any;
    const store = new InMemoryBotActivityLogStore();
    const service = new BotActivityLogService(client, store, 'log-guild');

    await service.logAiDiagnostic({
      guildId: 'guild-1',
      guildName: 'source',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: 'tester',
      stage: 'planner',
      event: 'rate_limit',
      model: 'openai/gpt-oss-20b',
      usageScope: 'planner',
      decisionKind: 'command',
      commandSafety: 'voice-precondition',
      retryCount: 1,
      validationErrors: ['bad json'],
      promptSnippet: 'p'.repeat(700),
      responseSnippet: 'r'.repeat(700),
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      status: 429,
      errorName: 'RateLimitError',
      errorMessage: 'too many',
      rateLimitHeaders: {
        'retry-after': '2',
        'x-ratelimit-remaining-tokens': '0',
        authorization: 'secret'
      }
    });

    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = send.mock.calls[0] as unknown as [{ content: string }];
    const content = firstCall[0].content;
    expect(content).toContain('general-channel-1-AI');
    expect(content).toContain('stage=planner');
    expect(content).toContain('event=rate_limit');
    expect(content).toContain('promptTokens=10');
    expect(content).toContain('retry-after=2');
    expect(content).not.toContain('authorization=secret');
    expect(content.length).toBeLessThanOrEqual(1500);
  });
});

describe('BotActivityLogService.logCleanupResult', () => {
  it('logs cleanup execution results to the source guild log channel', async () => {
    const send = vi.fn(async () => undefined);
    const logChannel = { id: 'log-channel', type: ChannelType.GuildText, name: 'LOG-source', topic: 'Source guild: source (guild-1)', send };
    const sourceChannel = { id: 'channel-1', type: ChannelType.GuildText, name: 'general' };
    const loggingGuild = {
      id: 'log-guild',
      name: 'log',
      channels: {
        fetch: vi.fn(async (id?: string) => (id === 'log-channel' ? logChannel : null)),
        create: vi.fn(async () => logChannel),
        cache: new Map()
      }
    };
    const sourceGuild = {
      id: 'guild-1',
      name: 'source',
      channels: {
        fetch: vi.fn(async (id?: string) => (id === 'channel-1' ? sourceChannel : null)),
        cache: new Map([['channel-1', sourceChannel]])
      }
    };
    const client = {
      guilds: {
        fetch: vi.fn(async (id?: string) => (id === 'log-guild' ? loggingGuild : sourceGuild))
      }
    } as any;
    const store = new InMemoryBotActivityLogStore();
    const service = new BotActivityLogService(client, store, 'log-guild');

    await service.logCleanupResult({
      guildId: 'guild-1',
      guildName: 'source',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: '서버닉',
      commandName: '대청소',
      scope: 'purge',
      requested: 4,
      matched: 4,
      deleted: 4,
      skippedOld: 0,
      exhausted: true
    });

    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = send.mock.calls[0] as unknown as [{ content: string }];
    expect(firstCall[0].content).toContain('general-channel-1-CLEANUP');
    expect(firstCall[0].content).toContain('userName=서버닉');
    expect(firstCall[0].content).toContain('command=대청소');
    expect(firstCall[0].content).toContain('scope=purge');
    expect(firstCall[0].content).toContain('deleted=4');
  });
});
