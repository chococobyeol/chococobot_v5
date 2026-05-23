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

  it('logs agent and tool diagnostic fields', async () => {
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
    const service = new BotActivityLogService(client, new InMemoryBotActivityLogStore(), 'log-guild');

    await service.logAiDiagnostic({
      guildId: 'guild-1',
      guildName: 'source',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: 'tester',
      stage: 'tool',
      event: 'observation',
      runId: 'agent-run-1',
      iteration: 2,
      toolCallId: 'call_1',
      toolName: 'time.in_zone',
      policy: 'read_only_auto',
      observationSummary: '{"status":"ok"}'
    });

    const content = (send.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(content).toContain('stage=tool');
    expect(content).toContain('event=observation');
    expect(content).toContain('runId=agent-run-1');
    expect(content).toContain('iteration=2');
    expect(content).toContain('toolCallId=call_1');
    expect(content).toContain('toolName=time.in_zone');
    expect(content).toContain('policy=read_only_auto');
    expect(content).toContain('observationSummary={"status":"ok"}');
  });

  it('redacts raw web-search query text from AI diagnostic logs', async () => {
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
    const service = new BotActivityLogService(client, new InMemoryBotActivityLogStore(), 'log-guild');

    await service.logAiDiagnostic({
      guildId: 'guild-1',
      guildName: 'source',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: 'tester',
      stage: 'tool',
      event: 'observation',
      toolName: 'web.search',
      observationSummary: '{"provider":"searxng","query":"private raw query","results":1}',
      promptSnippet: 'web.search {"query":"private raw query"}',
      responseSnippet: 'ok'
    });

    const content = (send.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(content).toContain('toolName=web.search');
    expect(content).toContain('[redacted-web-search-query]');
    expect(content).not.toContain('private raw query');
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

describe('BotActivityLogService.ensureGuildLogChannel', () => {
  it('reuses an existing source log channel by name when the local store is empty', async () => {
    const edit = vi.fn(async () => undefined);
    const existingLogChannel = {
      id: 'existing-log',
      type: ChannelType.GuildText,
      name: 'LOG-source-guild-1',
      topic: 'Source guild: source (guild-1)',
      parentId: 'full-category',
      edit,
      send: vi.fn(async () => undefined)
    };
    const fullCategory = { id: 'full-category', type: ChannelType.GuildCategory, name: '서버별 로그' };
    const loggingGuild = {
      id: 'log-guild',
      name: 'log',
      channels: {
        fetch: vi.fn(async () => null),
        create: vi.fn(async () => {
          throw new Error('should not create duplicate log channel');
        }),
        cache: new Map([
          ['full-category', fullCategory],
          ['existing-log', existingLogChannel]
        ])
      }
    };
    const sourceGuild = {
      id: 'guild-1',
      name: 'source',
      channels: {
        fetch: vi.fn(async () => null),
        cache: new Map()
      }
    };
    const client = {
      guilds: {
        fetch: vi.fn(async (id?: string) => (id === 'log-guild' ? loggingGuild : sourceGuild))
      }
    } as any;
    const store = new InMemoryBotActivityLogStore();
    const service = new BotActivityLogService(client, store, 'log-guild');

    const channel = await service.ensureGuildLogChannel('guild-1');

    expect(channel).toBe(existingLogChannel);
    expect(loggingGuild.channels.create).not.toHaveBeenCalled();
    expect(store.getLogChannelId('guild-1')).toBe('existing-log');
  });
});

describe('BotActivityLogService.deleteManagedLogChannels', () => {
  it('deletes only managed source log text channels and clears the stored mapping', async () => {
    const deleteLogByName = vi.fn(async () => undefined);
    const deleteLogByTopic = vi.fn(async () => undefined);
    const unmanagedDelete = vi.fn(async () => undefined);
    const managedByName = {
      id: 'log-by-name',
      type: ChannelType.GuildText,
      name: 'LOG-source-guild-1',
      topic: null,
      delete: deleteLogByName
    };
    const managedByTopic = {
      id: 'log-by-topic',
      type: ChannelType.GuildText,
      name: 'custom',
      topic: 'Source guild: source (guild-2)',
      delete: deleteLogByTopic
    };
    const unmanaged = {
      id: 'general',
      type: ChannelType.GuildText,
      name: 'general',
      topic: null,
      delete: unmanagedDelete
    };
    const loggingGuild = {
      id: 'log-guild',
      name: 'log',
      channels: {
        fetch: vi.fn(async () => new Map([
          ['log-by-name', managedByName],
          ['log-by-topic', managedByTopic],
          ['general', unmanaged]
        ] as Array<[string, any]>)),
        cache: new Map()
      }
    };
    const client = {
      guilds: {
        fetch: vi.fn(async () => loggingGuild)
      }
    } as any;
    const store = new InMemoryBotActivityLogStore();
    store.setLogChannelId('guild-1', 'log-by-name');
    const service = new BotActivityLogService(client, store, 'log-guild');

    const result = await service.deleteManagedLogChannels();

    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(deleteLogByName).toHaveBeenCalledTimes(1);
    expect(deleteLogByTopic).toHaveBeenCalledTimes(1);
    expect(unmanagedDelete).not.toHaveBeenCalled();
    expect(store.getLogChannelId('guild-1')).toBeUndefined();
  });
});
