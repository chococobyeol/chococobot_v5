import { ChannelType, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingChannelHistoryRequestsForTests, createPrefixCommands, handleMessageCreate } from '../src/bot.js';
import { ConfirmationManager } from '../src/services/confirmationManager.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';
import { AgentTurnContextStore } from '../src/services/agentTurnContextStore.js';

function makeMessage(content: string, overrides: Record<string, unknown> = {}) {
  const reply = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  return {
    id: 'message-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    content,
    cleanContent: content,
    channel: {
      id: 'channel-1',
      type: ChannelType.GuildText,
      send
    },
    guild: {
      name: '테스트서버',
      channels: {
        cache: new Map([
          [
            'channel-1',
            {
              id: 'channel-1',
              name: 'general',
              type: ChannelType.GuildText
            }
          ]
        ])
      }
    },
    author: {
      id: 'user-1',
      username: 'tester',
      bot: false
    },
    member: {
      displayName: '테스터',
      voice: {
        channel: {
          id: 'voice-1'
        }
      }
    },
    mentions: {
      channels: {
        first: vi.fn(() => null)
      }
    },
    reply,
    client: {
      user: {
        id: 'bot-1',
        username: 'ChococoBot'
      }
    },
    ...overrides
  } as any;
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const voiceSettings = new InMemoryVoiceSettingsStore();
  voiceSettings.setWatchedChannelId('guild-1', 'channel-1');
  return {
    settings: {
      ttsReadBotMessages: false,
      ttsMaxChars: 500,
      cleanMineDefaultTarget: 500,
      cleanMineMaxLimit: 500,
      cleanAllDefaultTarget: 1000,
      cleanAllMaxLimit: 1000,
      webSearchEnabled: true,
      webSearchProvider: 'searxng',
      webSearchBaseUrl: 'http://search.local',
      webSearchTimeoutMs: 5000,
      webSearchResultCount: 3,
      webSearchDefaultMode: 'search_first_factual'
    },
    voiceSettings,
    aiChat: {
      handlePrompt: vi.fn(async () => true),
      resetGuildMemory: vi.fn(async () => undefined)
    },
    webSearchProvider: {
      status: vi.fn(() => 'ready')
    },
    ai: {
      askMessages: vi.fn(async () => '채널 기록 답변'),
      askMessagesDetailed: vi.fn(async () => ({
        content: 'AI 확인 안내: 이 작업 진행해도 괜찮을까요?',
        model: 'test-model',
        usageScope: 'agent',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        rateLimitHeaders: {}
      }))
    },
    voice: {
      enqueueMessage: vi.fn(async () => true),
      join: vi.fn(async () => undefined),
      leave: vi.fn(() => undefined),
      speak: vi.fn(async () => true),
      stopPlayback: vi.fn(() => true),
      setWatchedChannel: vi.fn((guildId: string, channelId: string, enabled: boolean) => {
        if (enabled) voiceSettings.setWatchedChannelId(guildId, channelId);
        else voiceSettings.setWatchedChannelId(guildId, undefined);
      }),
      getWatchedChannelId: vi.fn((guildId: string) => voiceSettings.getWatchedChannelId(guildId)),
      getUserTtsEngine: vi.fn(() => 'edge'),
      getUserVoicePreset: vi.fn(() => 'sunhi'),
      isConnected: vi.fn(() => false)
    },
    activityLog: {
      logCommand: vi.fn(async () => undefined),
      logCleanupResult: vi.fn(async () => undefined),
      logChannelHistory: vi.fn(async () => undefined),
      deleteManagedLogChannels: vi.fn(async () => ({ deleted: 2, failed: 0 })),
      logError: vi.fn(async () => undefined),
      logTtsRequest: vi.fn(async () => undefined),
      logVoiceConnection: vi.fn(async () => undefined),
      logAiDiagnostic: vi.fn(async () => undefined)
    },
    ...overrides
  } as any;
}

describe('handleMessageCreate', () => {
  beforeEach(() => {
    clearPendingChannelHistoryRequestsForTests();
  });
  it('keeps existing prefix commands ahead of the natural-language router', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!도움말');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('현재 프리픽스는 `!`예요...')
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('shows a clarify prompt for bare prefix-question messages', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!?');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('뒤에 질문이나 요청을 적어 주세요')
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('routes ordinary messages in the configured AI channel to AI chat', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    context.voiceSettings.setAiChannelId('guild-1', 'channel-1');
    const message = makeMessage('안녕 초코코');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '안녕 초코코');
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('keeps prefixed commands in the configured AI channel on the command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    context.voiceSettings.setAiChannelId('guild-1', 'channel-1');
    const message = makeMessage('!도움말');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('현재 프리픽스는 `!`예요...')
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('runs AI-channel natural command requests through the agent confirmation path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const confirmations = new ConfirmationManager();
    context.voiceSettings.setAiChannelId('guild-1', 'channel-1');
    context.agentRuntime = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'confirmation_required',
          message: 'AI 채널 변경 전 확인이 필요해요...',
          intent: 'settings.ai_channel',
          preview: 'Confirm settings.ai_channel',
          commandQuery: 'ai채널 해제',
          payload: { action: 'clear' }
        })
        .mockResolvedValueOnce({ kind: 'confirm_pending' })
    } as any;
    const adminMember = {
      displayName: '관리자',
      permissions: { has: vi.fn(() => true) },
      voice: { channel: { id: 'voice-1' } }
    };

    const first = makeMessage('이 대화채널을 ai 채팅채널 해제 해줘', { member: adminMember });
    await handleMessageCreate(first, commands, context as any, confirmations);

    expect(context.agentRuntime.run).toHaveBeenCalledWith(
      first,
      '이 대화채널을 ai 채팅채널 해제 해줘',
      expect.objectContaining({ prefix: '!' })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voiceSettings.getAiChannelId('guild-1')).toBe('channel-1');
    expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('AI 확인 안내') }));

    const second = makeMessage('ㅇㅇ', { id: 'message-2', member: adminMember });
    await handleMessageCreate(second, commands, context as any, confirmations);

    expect(context.voiceSettings.getAiChannelId('guild-1')).toBeUndefined();
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'AI 채팅 채널 설정을 해제했어요...' }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('deletes the cleanup command message plus the requested number of user messages without posting a public success message', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!청소 3');
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = {
      fetch: vi.fn(async () =>
        new Collection([
          ['message-1', { id: 'message-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-3', { id: 'chat-3', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-2', { id: 'chat-2', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-1', { id: 'chat-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
        ])
      )
    };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(cleanupChannel.bulkDelete).toHaveBeenCalledTimes(1);
    expect(cleanupChannel.bulkDelete.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual([
      'message-1',
      'chat-3',
      'chat-2',
      'chat-1'
    ]);
    expect(cleanupChannel.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(context.activityLog.logCleanupResult).toHaveBeenCalledWith({
      guildId: 'guild-1',
      guildName: '테스트서버',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: '테스터',
      commandName: '청소',
      scope: 'own',
      requested: 3,
      deleted: 3,
      matched: 3,
      skippedOld: 0,
      exhausted: true
    });
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('announces the server nickname that requested purge cleanup', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!대청소 3', {
      member: {
        displayName: '서버닉',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = {
      fetch: vi.fn(async () =>
        new Collection([
          ['message-1', { id: 'message-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-3', { id: 'chat-3', author: { id: 'user-3' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-2', { id: 'chat-2', author: { id: 'user-2' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['chat-1', { id: 'chat-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
        ])
      )
    };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(cleanupChannel.bulkDelete).toHaveBeenCalledTimes(1);
    expect(cleanupChannel.bulkDelete.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual([
      'message-1',
      'chat-3',
      'chat-2',
      'chat-1'
    ]);
    expect(cleanupChannel.send).toHaveBeenCalledWith({
      content: '서버닉님의 요청으로 메시지 3개를 삭제했어요...',
      allowedMentions: { parse: [], repliedUser: false }
    });
    expect(context.activityLog.logCleanupResult).toHaveBeenCalledWith({
      guildId: 'guild-1',
      guildName: '테스트서버',
      channelId: 'channel-1',
      userId: 'user-1',
      userName: '서버닉',
      commandName: '대청소',
      scope: 'purge',
      requested: 3,
      deleted: 3,
      matched: 3,
      skippedOld: 0,
      exhausted: true
    });
    expect(message.reply).not.toHaveBeenCalled();
  });


  it('keeps direct cleanup without an explicit count on the own-message cleanup path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!청소');
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = {
      fetch: vi.fn(async () =>
        new Collection([
          ['message-1', { id: 'message-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['own-2', { id: 'own-2', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['other-1', { id: 'other-1', author: { id: 'other-user' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['own-1', { id: 'own-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
        ])
      )
    };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(cleanupChannel.bulkDelete.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual(['message-1', 'own-2', 'own-1']);
    expect(context.activityLog.logCleanupResult).toHaveBeenCalledWith(expect.objectContaining({
      commandName: '청소',
      scope: 'own',
      deleted: 2
    }));
    expect(context.activityLog.logCommand).toHaveBeenCalledWith(expect.objectContaining({ commandName: '청소' }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('blocks direct purge cleanup before deletion when requester lacks manage-message permission', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!대청소 3', {
      member: {
        displayName: '일반유저',
        permissions: { has: vi.fn(() => false) },
        voice: { channel: { id: 'voice-1' } }
      }
    });
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = { fetch: vi.fn(async () => new Collection()) };
    cleanupChannel.bulkDelete = vi.fn(async () => new Collection());

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(cleanupChannel.bulkDelete).not.toHaveBeenCalled();
    expect(context.activityLog.logCleanupResult).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('관리자 권한') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it.each(['!이리와', '!들어와'])('routes direct voice join command %s through the prefix command path', async (content) => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage(content);

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.join).toHaveBeenCalledWith(message.member);
    expect(context.activityLog.logVoiceConnection).toHaveBeenCalledWith(expect.objectContaining({ message: 'voice joined' }));
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('음성 채널') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('routes direct voice leave command through the prefix command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!나가');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.leave).toHaveBeenCalledWith('guild-1');
    expect(context.activityLog.logVoiceConnection).toHaveBeenCalledWith(expect.objectContaining({ message: 'voice left' }));
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('음성 채널') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('routes direct speak commands through voice auto-join and TTS dispatch', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!말 안녕하세요');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.join).toHaveBeenCalledWith(message.member);
    expect(context.activityLog.logTtsRequest).toHaveBeenCalledWith(expect.objectContaining({ source: 'command', text: '안녕하세요' }));
    expect(context.voice.speak).toHaveBeenCalledWith('guild-1', '안녕하세요', 'user-1');
    expect(message.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('읽을 문장') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('clarifies direct speak commands with missing text without joining or speaking', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!말');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('읽을 문장') }));
    expect(context.voice.join).not.toHaveBeenCalled();
    expect(context.voice.speak).not.toHaveBeenCalled();
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('shows and updates direct TTS channel settings through the prefix command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();

    const show = makeMessage('!tts채널 현재');
    await handleMessageCreate(show, commands, context as any, new ConfirmationManager());
    expect(show.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('현재 TTS 채널') }));

    const set = makeMessage('!tts채널 #general');
    set.mentions.channels.first = vi.fn(() => set.guild.channels.cache.get('channel-1'));
    await handleMessageCreate(set, commands, context as any, new ConfirmationManager());

    expect(context.voice.setWatchedChannel).toHaveBeenCalledWith('guild-1', 'channel-1', true);
    expect(set.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('TTS 채널') }));

    const clear = makeMessage('!tts채널 해제', { id: 'message-2' });
    await handleMessageCreate(clear, commands, context as any, new ConfirmationManager());

    expect(context.voice.setWatchedChannel).toHaveBeenCalledWith('guild-1', 'channel-1', false);
    expect(clear.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('해제') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('keeps direct prefix reads open but blocks non-admin prefix changes', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();

    const show = makeMessage('!프리픽스');
    await handleMessageCreate(show, commands, context as any, new ConfirmationManager());
    expect(show.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('현재 프리픽스') }));

    const denied = makeMessage('!프리픽스 ~');
    await handleMessageCreate(denied, commands, context as any, new ConfirmationManager());

    expect(context.voiceSettings.getCommandPrefix('guild-1')).toBeUndefined();
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('서버 관리자') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('allows direct admin prefix changes through the prefix command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!프리픽스 ~', {
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voiceSettings.getCommandPrefix('guild-1')).toBe('~');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('프리픽스') }));
    expect(context.activityLog.logCommand).toHaveBeenCalledWith(expect.objectContaining({ commandName: '프리픽스' }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('blocks direct memory reset before mutation when requester is not an administrator', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!기억삭제');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.resetGuildMemory).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('서버 관리자') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('allows direct admin memory reset through the prefix command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!기억삭제', {
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.resetGuildMemory).toHaveBeenCalledWith('guild-1');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('기억') }));
    expect(context.activityLog.logCommand).toHaveBeenCalledWith(expect.objectContaining({ commandName: '기억삭제' }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('deletes managed log channels only inside the logging guild', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      settings: {
        ttsReadBotMessages: false,
        ttsMaxChars: 500,
        cleanMineDefaultTarget: 500,
        cleanMineMaxLimit: 500,
        cleanAllDefaultTarget: 1000,
        cleanAllMaxLimit: 1000,
        loggingGuildId: 'log-guild'
      }
    });
    const message = makeMessage('!로그채널삭제', {
      guildId: 'log-guild',
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.activityLog.deleteManagedLogChannels).toHaveBeenCalledTimes(1);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '로그 채널 2개를 삭제했어요...'
    }));
  });

  it('rejects log channel deletion outside the logging guild', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      settings: {
        ttsReadBotMessages: false,
        ttsMaxChars: 500,
        cleanMineDefaultTarget: 500,
        cleanMineMaxLimit: 500,
        cleanAllDefaultTarget: 1000,
        cleanAllMaxLimit: 1000,
        loggingGuildId: 'log-guild'
      }
    });
    const message = makeMessage('!로그채널삭제', {
      guildId: 'guild-1',
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.activityLog.deleteManagedLogChannels).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '로그 서버에서만 사용할 수 있어요...'
    }));
  });

  it('routes supported prefix-question commands to the existing command execution path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!? 들어와');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.join).toHaveBeenCalledTimes(1);
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('keeps unsupported prefix-question payloads on the AI-chat fallback path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('!? 알려줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '알려줘');
    expect(context.voice.enqueueMessage).not.toHaveBeenCalled();
  });

  it('routes AI-planned cleanup requests into the existing cleanup command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '청소 2' }))
      }
    });
    const message = makeMessage('!? 내 채팅 2개 지워줘');
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = {
      fetch: vi.fn(async () =>
        new Collection([
          ['1', { id: '1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['2', { id: '2', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
        ])
      )
    };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiCommandPlanner.plan).toHaveBeenCalledWith(
      message,
      '내 채팅 2개 지워줘',
      expect.objectContaining({
        prefix: '!',
        commands
      })
    );
    expect(cleanupChannel.bulkDelete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('AI 확인 안내')
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('routes AI-planned voice requests into the existing speak command path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '말 안녕하세요' }))
      }
    });
    const message = makeMessage('!? 음성채널에서 안녕하세요 라고 말해봐');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.join).toHaveBeenCalledTimes(1);
    expect(context.voice.speak).toHaveBeenCalledWith('guild-1', '안녕하세요', 'user-1');
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('asks for confirmation when AI selects a purge command', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '대청소 2' }))
      }
    });
    const message = makeMessage('!? 모든 채팅 지워줘', {
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('AI 확인 안내')
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('retries invalid AI confirmation copy instead of sending an empty-response placeholder', async () => {
    const commands = createPrefixCommands();
    const askMessagesDetailed = vi
      .fn()
      .mockResolvedValueOnce({
        content: '응답이 비어 있어요...',
        model: 'test-model',
        usageScope: 'agent',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        rateLimitHeaders: {}
      })
      .mockResolvedValueOnce({
        content: '채널 채팅 2개를 지워도 될까요? 괜찮으면 편하게 답해 주세요.',
        model: 'test-model',
        usageScope: 'agent',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        rateLimitHeaders: {}
      });
    const context = makeContext({
      ai: {
        askMessages: vi.fn(async () => '채널 기록 답변'),
        askMessagesDetailed
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '대청소 2' }))
      }
    });
    const message = makeMessage('!? 전체 채팅 2개 지워줘', {
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(askMessagesDetailed).toHaveBeenCalledTimes(2);
    expect(askMessagesDetailed.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('사용자에게 보낼 수 없어요') })
    ]));
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('채널 채팅 2개를 지워도 될까요?')
    }));
    expect(message.reply).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('응답이 비어 있어요')
    }));
  });

  it('executes pending confirmation when AI interprets the prefix reply as approval', async () => {
    const commands = createPrefixCommands();
    const confirmations = new ConfirmationManager();
    const context = makeContext({
      agentRuntime: {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            kind: 'confirmation_required',
            message: '대청소 전 확인이 필요해요...',
            intent: 'command.mass_cleanup',
            preview: 'Confirm command.mass_cleanup',
            commandQuery: '대청소 3',
            payload: { target: 'channel', count: 3 }
          })
          .mockResolvedValueOnce({ kind: 'confirm_pending' })
      }
    });
    const member = {
      displayName: '관리자',
      permissions: { has: vi.fn(() => true) },
      voice: { channel: { id: 'voice-1' } }
    };
    const first = makeMessage('!? 전체 채팅 3개 지워봐', { member });
    const second = makeMessage('!? ㅇ..', { id: 'message-2', member });
    const cleanupChannel = first.channel as any;
    const fetched = new Collection([
      ['message-2', { id: 'message-2', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
      ['chat-3', { id: 'chat-3', author: { id: 'user-3' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
      ['chat-2', { id: 'chat-2', author: { id: 'user-2' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
      ['chat-1', { id: 'chat-1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
    ]);
    cleanupChannel.messages = { fetch: vi.fn(async () => fetched) };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));
    second.channel = cleanupChannel;

    await handleMessageCreate(first, commands, context as any, confirmations);
    await handleMessageCreate(second, commands, context as any, confirmations);

    expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('AI 확인 안내') }));
    expect(context.agentRuntime.run).toHaveBeenCalledTimes(2);
    expect(context.agentRuntime.run).toHaveBeenLastCalledWith(
      second,
      'ㅇ..',
      expect.objectContaining({ pendingConfirmation: expect.objectContaining({ commandQuery: '대청소 3' }) })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalledWith(second, 'ㅇ..');
    expect(cleanupChannel.bulkDelete).toHaveBeenCalledTimes(1);
    expect(cleanupChannel.bulkDelete.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual([
      'message-2',
      'chat-3',
      'chat-2',
      'chat-1'
    ]);
  });

  it('blocks non-admin AI-planned purge before confirmation or deletion', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '대청소 100' }))
      }
    });
    const confirmations = new ConfirmationManager();
    const message = makeMessage('!? 전체 채팅 지워줘', {
      member: {
        displayName: '일반유저',
        permissions: { has: vi.fn(() => false) },
        voice: { channel: { id: 'voice-1' } }
      }
    });
    const cleanupChannel = message.channel as any;
    cleanupChannel.bulkDelete = vi.fn(async () => new Collection());
    cleanupChannel.messages = { fetch: vi.fn(async () => new Collection()) };

    await handleMessageCreate(message, commands, context as any, confirmations);

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '이 작업은 관리자 권한이 필요해요...'
    }));
    expect(cleanupChannel.bulkDelete).not.toHaveBeenCalled();
    expect(context.activityLog.logCleanupResult).not.toHaveBeenCalled();
    expect(confirmations.get('missing')).toBeUndefined();
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });


  it('replies unavailable for explicit voice AI requests when user is not in voice', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '말 안녕' }))
      }
    });
    const message = makeMessage('!? 음성채널에서 안녕이라고 말해줘', {
      member: {
        displayName: '테스터',
        voice: {
          channel: null
        }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('음성 채널에 들어가')
      })
    );
    expect(context.voice.join).not.toHaveBeenCalled();
    expect(context.voice.speak).not.toHaveBeenCalled();
  });

  it('asks a concrete clarification for ambiguous AI command intent', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'clarify', message: '채팅으로 답할까요, 음성으로 말할까요?' }))
      }
    });
    const message = makeMessage('!? 안녕이라고 말해봐');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '채팅으로 답할까요, 음성으로 말할까요?'
      })
    );
    expect(context.voice.speak).not.toHaveBeenCalled();
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('falls back to chat when planner has a non-rate error', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => { throw new Error('planner failed'); })
      }
    });
    const message = makeMessage('!? 알려줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '알려줘');
  });

  it('does not call chat again when planner is rate limited', async () => {
    const commands = createPrefixCommands();
    const rateError = Object.assign(new Error('rate limit'), { status: 429 });
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => { throw rateError; })
      }
    });
    const message = makeMessage('!? 알려줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('조금 뒤에 다시 시도') }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('routes AI-planned channel summary requests into the channel-history path', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '#memo',
          query: '메모 채널 내용 요약해줘'
        }))
      }
    });
    const message = makeMessage('!? 메모 채널의 내용을 요약해줘');
    const memoChannel = {
      id: 'memo-1',
      name: '메모채널',
      type: ChannelType.GuildText,
      fetch: vi.fn(async () =>
        [
          {
            id: '1',
            channelId: 'memo-1',
            createdTimestamp: Date.now(),
            content: '첫 메시지',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          },
          {
            id: '2',
            channelId: 'memo-1',
            createdTimestamp: Date.now(),
            content: '봇 메시지',
            author: { id: 'bot-1', username: 'ChococoBot', bot: true },
            member: { displayName: 'ChococoBot' }
          }
        ] as any
      )
    };
    (memoChannel as any).messages = {
      fetch: memoChannel.fetch
    };
    message.guild.channels.cache.set('memo-1', memoChannel);

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.ai.askMessages).toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '채널 기록 답변'
      })
    );
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('채널: #메모채널') })
        ])
      })
    );
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(1);
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('respects planner chat decisions instead of regex-routing history prompts', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
      }
    });
    const message = makeMessage('!? 없는채널 내용 요약해줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '없는채널 내용 요약해줘');
    expect(context.ai.askMessages).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(1);
  });

  it('summarizes recent conversations across text channels when AI plans a server history summary', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '서버 전체',
          query: '최근 내용 요약해줘'
        }))
      }
    });
    const now = Date.now();
    const message = makeMessage('!? 최근에 무슨 대화 했지?');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'general-message-1',
            channelId: 'channel-1',
            createdTimestamp: now - 1_000,
            content: '일반 채널 대화',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };
    message.guild.channels.cache.set('memo-3', {
      id: 'memo-3',
      name: '메모채널',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async () =>
          [
            {
              id: 'memo-message-3',
              channelId: 'memo-3',
              createdTimestamp: now - 500,
              content: '메모 채널 대화',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { displayName: '작성자' }
            }
          ] as any
        )
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('채널: #general') }),
          expect.objectContaining({ content: expect.stringContaining('채널: #메모채널') }),
          expect.objectContaining({ content: expect.stringContaining('<t:') })
        ])
      })
    );
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(1);
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('searches server text history for topic lookup requests before falling back to chat', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '서버 전체',
          query: '짬뽕지존'
        }))
      }
    });
    const message = makeMessage('!? 이 서버에 짬뽕지존에 관한 내용이 있는지 찾아봐');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'topic-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '짬뽕지존 얘기를 했어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('짬뽕지존 얘기를 했어요') })
        ])
      })
    );
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '짬뽕지존',
      matchedMessages: 1,
      usedMessages: 1
    }));
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(1);
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('lets AI reject unrelated recent history when a topic lookup has no exact matches', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      ai: {
        askMessages: vi.fn(async () => '정성카츠 관련 내용은 찾지 못했어요...')
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'qa',
          targetChannelReference: '서버 전체',
          query: '정성카츠'
        }))
      }
    });
    const message = makeMessage('!? 대화내용중에 정성카츠에 대한 내용이 있나?');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'unrelated-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '다른 식당 얘기만 했어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '정성카츠 관련 내용은 찾지 못했어요...' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 정성카츠') }),
          expect.objectContaining({ content: expect.stringContaining('다른 식당 얘기만 했어요') })
        ])
      })
    );
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '정성카츠',
      matchedMessages: 0,
      usedMessages: 1
    }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('lets AI judge fuzzy topic searches using recent history instead of exact-match rejecting them', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'qa',
          targetChannelReference: '서버 전체',
          query: '파스타 비슷한거'
        }))
      }
    });
    const message = makeMessage('!? 대화내용중에 파스타나 뭐 그런 비슷한거에 대한 내용 찾아줘');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'fuzzy-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '스파게티 먹자는 얘기가 있었어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 파스타 비슷한거') }),
          expect.objectContaining({ content: expect.stringContaining('스파게티 먹자는 얘기가 있었어요') })
        ])
      })
    );
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '파스타 비슷한거',
      matchedMessages: 0,
      usedMessages: 1
    }));
  });

  it('treats short planner queries as topics and refines them from follow-up questions', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi
          .fn()
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'summary',
            targetChannelReference: '서버 전체',
            query: '짬뽕'
          })
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'summary',
            targetChannelReference: '서버 전체',
            query: '짬뽕지존'
          })
      }
    });
    const first = makeMessage('!? 대화 대용중에 짬뽕에 관한 내용 있나?');
    const second = makeMessage('!? 왜 없지? 짬뽕지존은?');
    const generalMessages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'jjamppong-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '짬뽕지존 얘기가 있었어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };
    (first.guild.channels.cache.get('channel-1') as any).messages = generalMessages;
    (second.guild.channels.cache.get('channel-1') as any).messages = generalMessages;

    await handleMessageCreate(first, commands, context as any, new ConfirmationManager());
    await handleMessageCreate(second, commands, context as any, new ConfirmationManager());

    expect(context.ai.askMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 짬뽕') }),
          expect.objectContaining({ content: expect.stringContaining('짬뽕지존 얘기가 있었어요') })
        ])
      })
    );
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 짬뽕지존') }),
          expect.objectContaining({ content: expect.stringContaining('짬뽕지존 얘기가 있었어요') })
        ])
      })
    );
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(2);
  });

  it('remembers a successful server topic search for channel-only follow-up searches', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi
          .fn()
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'summary',
            targetChannelReference: '서버 전체',
            query: '치킨 비슷한거'
          })
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'summary',
            targetChannelReference: '#배달',
            query: '치킨 비슷한거'
          })
      }
    });
    const first = makeMessage('!? 치킨 비슷한거에 대한 내용 대화중에 있나 봐줘');
    const second = makeMessage('!? 배달 이 채널에서 봐줘');
    const generalChannel = first.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'chicken-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '치킨 얘기가 있었어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };
    const deliveryChannel = {
      id: 'delivery-2',
      name: '배달',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async () =>
          [
            {
              id: 'delivery-chicken-1',
              channelId: 'delivery-2',
              createdTimestamp: Date.now(),
              content: '닭강정 시키자는 얘기가 있었어요',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { displayName: '작성자' }
            }
          ] as any
        )
      }
    };
    first.guild.channels.cache.set('delivery-2', deliveryChannel);
    second.guild.channels.cache.set('delivery-2', deliveryChannel);

    await handleMessageCreate(first, commands, context as any, new ConfirmationManager());
    await handleMessageCreate(second, commands, context as any, new ConfirmationManager());

    expect(context.ai.askMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 치킨 비슷한거') }),
          expect.objectContaining({ content: expect.stringContaining('채널: #배달') }),
          expect.objectContaining({ content: expect.stringContaining('닭강정 시키자는 얘기가 있었어요') })
        ])
      })
    );
    expect(context.aiCommandPlanner.plan).toHaveBeenCalledTimes(2);
  });

  it('retries the previous missing server topic in a channel named by the next message', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      ai: {
        askMessages: vi
          .fn()
          .mockResolvedValueOnce('초밥 관련 내용은 서버에서 찾지 못했어요...')
          .mockResolvedValueOnce('채널 기록 답변')
      },
      aiCommandPlanner: {
        plan: vi
          .fn()
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'qa',
            targetChannelReference: '서버 전체',
            query: '초밥'
          })
          .mockResolvedValueOnce({ kind: 'chat' })
      }
    });
    const first = makeMessage('!? 대화내용중에 초밥에관한 내용 있나?');
    const second = makeMessage('!? 배달 여기서 찾아봐');
    const generalChannel = first.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'general-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '다른 얘기만 있어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };
    const deliveryChannel = {
      id: 'delivery-1',
      name: '배달',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async ({ limit }: { limit: number }) =>
          [
            {
              id: 'delivery-message-1',
              channelId: 'delivery-1',
              createdTimestamp: Date.now(),
              content: '초밥 주문하자는 얘기가 있었어요',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { displayName: '작성자' }
            }
          ].slice(0, limit) as any
        )
      }
    };
    await handleMessageCreate(first, commands, context as any, new ConfirmationManager());
    second.guild.channels.cache.set('delivery-1', deliveryChannel);
    await handleMessageCreate(second, commands, context as any, new ConfirmationManager());

    expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '초밥 관련 내용은 서버에서 찾지 못했어요...' }));
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 초밥') }),
          expect.objectContaining({ content: expect.stringContaining('채널: #배달') }),
          expect.objectContaining({ content: expect.stringContaining('초밥 주문하자는 얘기가 있었어요') })
        ])
      })
    );
    expect(deliveryChannel.messages.fetch).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('excludes bot diagnostic log messages from channel-history evidence', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'qa',
          targetChannelReference: 'channel-1',
          query: '초밥'
        }))
      }
    });
    const message = makeMessage('!? 여기서 초밥 찾아봐');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async ({ limit }: { limit: number }) =>
        [
          {
            id: 'bot-log-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: [
              '봇테스트창-1249316766874861730-AI',
              'guildName=힘내야지...',
              'userName=ㅊㅋㅂ',
              'stage=agent',
              'event=response',
              'response={"kind":"tool_calls","calls":[{"tool":"history.search","input":{"query":"초밥"}}]}'
            ].join('\n'),
            author: { id: 'bot-1', username: 'ChococoBot', bot: true },
            member: { displayName: 'ChococoBot' }
          },
          {
            id: 'real-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '초밥 맛집은 다음에 다시 얘기하기로 했어요',
            author: { id: 'user-2', username: 'writer', bot: false },
            member: { displayName: '작성자' }
          }
        ].slice(0, limit) as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('초밥 맛집은 다음에 다시 얘기하기로 했어요') })
        ])
      })
    );
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.not.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('stage=agent') }),
          expect.objectContaining({ content: expect.stringContaining('history.search') })
        ])
      })
    );
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      matchedMessages: 1,
      usedMessages: 1
    }));
  });

  it('routes planner server-wide history targets to guild search instead of resolving them as a channel', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '서버 전체',
            query: '햄버거 비슷한거'
        }))
      }
    });
    const message = makeMessage('!? 대화 내용중에 햄버거 비슷한거에 대한 내용 찾아봐');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async ({ limit }: { limit: number }) =>
        [
          {
            id: 'burger-message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '치킨버거 먹고 싶다는 얘기가 있었어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ].slice(0, limit) as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '채널 기록 답변' }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 햄버거 비슷한거') }),
          expect.objectContaining({ content: expect.stringContaining('치킨버거 먹고 싶다는 얘기가 있었어요') })
        ])
      })
    );
    expect(generalChannel.messages.fetch).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '햄버거 비슷한거',
      scannedChannels: 1,
      usedMessages: 1
    }));
  });

  it('blocks non-admin server-wide history searches inside the logging guild', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      settings: {
        ttsReadBotMessages: false,
        ttsMaxChars: 500,
        cleanMineDefaultTarget: 500,
        cleanMineMaxLimit: 500,
        cleanAllDefaultTarget: 1000,
        cleanAllMaxLimit: 1000,
        loggingGuildId: 'log-guild'
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '서버 전체',
          query: '토큰'
        }))
      }
    });
    const message = makeMessage('!? 서버 전체에서 토큰 찾아봐', {
      guildId: 'log-guild',
      member: {
        displayName: '일반유저',
        permissions: { has: vi.fn(() => false) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: '로그 서버의 전체 대화 검색은 관리자만 사용할 수 있어요...'
    }));
    expect(context.ai.askMessages).not.toHaveBeenCalled();
    expect(context.activityLog.logChannelHistory).not.toHaveBeenCalled();
  });

  it('excludes managed log channels from logging-guild server-wide history context', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      settings: {
        ttsReadBotMessages: false,
        ttsMaxChars: 500,
        cleanMineDefaultTarget: 500,
        cleanMineMaxLimit: 500,
        cleanAllDefaultTarget: 1000,
        cleanAllMaxLimit: 1000,
        loggingGuildId: 'log-guild'
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '서버 전체',
          query: '최근 내용 요약'
        }))
      }
    });
    const generalChannel = {
      id: 'general-log-guild',
      name: 'general',
      type: ChannelType.GuildText,
      topic: null,
      messages: {
        fetch: vi.fn(async () => new Collection([
          ['safe-1', {
            id: 'safe-1',
            channelId: 'general-log-guild',
            createdTimestamp: Date.now(),
            content: '일반 공지 내용',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }]
        ]))
      }
    };
    const managedLogChannel = {
      id: 'managed-log',
      name: 'LOG-source-guild',
      type: ChannelType.GuildText,
      topic: 'Source guild: source (guild-1)',
      messages: {
        fetch: vi.fn(async () => new Collection([
          ['secret-1', {
            id: 'secret-1',
            channelId: 'managed-log',
            createdTimestamp: Date.now(),
            content: '비밀 토큰 로그',
            author: { id: 'bot-1', username: 'ChococoBot', bot: true },
            member: { displayName: 'ChococoBot' }
          }]
        ]))
      }
    };
    const message = makeMessage('!? 최근 내용 요약해줘', {
      guildId: 'log-guild',
      guild: {
        name: '로그서버',
        channels: {
          cache: new Map([
            ['general-log-guild', generalChannel],
            ['managed-log', managedLogChannel]
          ] as Array<[string, any]>)
        }
      },
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(generalChannel.messages.fetch).toHaveBeenCalled();
    expect(managedLogChannel.messages.fetch).not.toHaveBeenCalled();
    expect(context.ai.askMessages).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('일반 공지 내용') })
      ])
    }));
    expect(context.ai.askMessages).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.not.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('비밀 토큰 로그') })
      ])
    }));
  });


  it('handles planner time plans with Discord viewer timestamps', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'time', target: 'viewer', offsetSeconds: 18_000 }))
      }
    });
    const message = makeMessage('!? 지금부터 5시간 후는 몇시야') as any;
    message.createdTimestamp = Date.parse('2026-05-22T18:15:00.000Z');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '<t:1779491700:t>예요...' }));
    expect(context.ai.askMessages).not.toHaveBeenCalled();
  });

  it('handles planner time plans for named zones', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'time', target: 'zone', timeZone: 'Europe/Budapest', label: '헝가리', offsetSeconds: 0 }))
      }
    });
    const message = makeMessage('!? 지금 헝가리 시간이 몇시야') as any;
    message.createdTimestamp = Date.parse('2026-05-22T18:15:00.000Z');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '헝가리 시간은 오후 8시 15분이에요...' }));
    expect(context.ai.askMessages).not.toHaveBeenCalled();
  });

  it('falls back to pending channel retry when planner fails to return JSON and then chat', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi
          .fn()
          .mockResolvedValueOnce({
            kind: 'channel-history',
            mode: 'summary',
            targetChannelReference: '서버 전체',
            query: '짬뽕지존'
          })
          .mockResolvedValueOnce({ kind: 'clarify', message: '어떤 내용을 검색할까요?' })
      }
    });
    const first = makeMessage('!? 대화내용중에 짬뽕지존에 관한 내용 있나 찾아봐');
    const second = makeMessage('!? 아니 그거 말고 힘내야지 배달 여기서 찾아');
    const generalChannel = first.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'general-jjamppong-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '짬뽕지존 얘기가 있었어요',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };
    const deliveryChannel = {
      id: 'delivery-3',
      name: '배달',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async () =>
          [
            {
              id: 'delivery-jjamppong-1',
              channelId: 'delivery-3',
              createdTimestamp: Date.now(),
              content: '배달 채널에서 짬뽕지존 얘기가 있었어요',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { displayName: '작성자' }
            }
          ] as any
        )
      }
    };
    first.guild.channels.cache.set('delivery-3', deliveryChannel);
    second.guild.channels.cache.set('delivery-3', deliveryChannel);

    await handleMessageCreate(first, commands, context as any, new ConfirmationManager());
    await handleMessageCreate(second, commands, context as any, new ConfirmationManager());

    expect(context.ai.askMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 짬뽕지존') }),
          expect.objectContaining({ content: expect.stringContaining('채널: #배달') }),
          expect.objectContaining({ content: expect.stringContaining('배달 채널에서 짬뽕지존 얘기가 있었어요') })
        ])
      })
    );
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('does not reinterpret bot-behavior complaints as history topic searches', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
      }
    });
    const message = makeMessage('!? 아 왜 최근 내용만 찾아');
    const generalChannel = message.guild.channels.cache.get('channel-1') as any;
    generalChannel.messages = {
      fetch: vi.fn(async () =>
        [
          {
            id: 'message-1',
            channelId: 'channel-1',
            createdTimestamp: Date.now(),
            content: '!? 아 왜 최근 내용만 찾아',
            author: { id: 'user-1', username: 'tester', bot: false },
            member: { displayName: '테스터' }
          }
        ] as any
      )
    };

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '아 왜 최근 내용만 찾아');
    expect(context.ai.askMessages).not.toHaveBeenCalled();
    expect(context.activityLog.logChannelHistory).not.toHaveBeenCalled();
  });


  it('clears agent follow-up context when a prefix command is used', async () => {
    const commands = createPrefixCommands();
    const agentTurnContextStore = new AgentTurnContextStore();
    agentTurnContextStore.set({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, {
      lastIntent: 'time',
      lastToolCalls: [{ tool: 'time.in_zone', input: { timeZone: 'America/New_York' } }],
      slots: { timeZones: ['America/New_York'] },
      observations: []
    });
    const context = makeContext({ agentTurnContextStore });
    const message = makeMessage('!도움말');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(agentTurnContextStore.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toBeUndefined();
  });

  it('does not clear agent follow-up context before prefix-question prompts', async () => {
    const commands = createPrefixCommands();
    const agentTurnContextStore = new AgentTurnContextStore();
    agentTurnContextStore.set({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, {
      lastIntent: 'clarify',
      lastUserPrompt: '메세지 삭제 해봐',
      lastAgentMessage: '누구 채팅을 몇 개 지울까요?',
      lastToolCalls: [],
      slots: {},
      observations: [],
      pendingAction: {
        kind: 'cleanup',
        originalPrompt: '메세지 삭제 해봐',
        target: 'ambiguous',
        missing: ['target', 'count']
      }
    });
    const context = makeContext({
      agentTurnContextStore,
      agentRuntime: {
        run: vi.fn(async () => ({ kind: 'blocked', message: '본인 메시지 삭제나 전체 채널 삭제만 가능해요.', blockedTools: ['command.cleanup'] }))
      }
    });
    const message = makeMessage('!? 니 메세지');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.agentRuntime.run).toHaveBeenCalled();
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(agentTurnContextStore.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toEqual(
      expect.objectContaining({
        lastIntent: 'clarify',
        pendingAction: expect.objectContaining({ originalPrompt: '메세지 삭제 해봐' })
      })
    );
  });

  it('invokes AgentRuntime before the fallback planner for non-empty prefix-question prompts', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({ kind: 'final', message: 'agent answer' }))
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'command', query: '말 안녕' }))
      }
    });
    const message = makeMessage('!? 알려줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.agentRuntime.run).toHaveBeenCalledWith(
      message,
      '알려줘',
      expect.objectContaining({ prefix: '!', executionContext: expect.objectContaining({ message, botContext: context }) })
    );
    expect(context.aiCommandPlanner.plan).not.toHaveBeenCalled();
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'agent answer' }));
  });

  it('does not fall back to the AI planner after AgentRuntime rejects a no-tool final', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({ kind: 'not_handled', reason: 'final_without_observation' }))
      },
      aiCommandPlanner: {
        plan: vi.fn(async () => ({
          kind: 'channel-history',
          mode: 'summary',
          targetChannelReference: '<#channel-1>',
          query: ''
        }))
      }
    });
    const message = makeMessage('!? 대화 내용 요약해봐');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.agentRuntime.run).toHaveBeenCalled();
    expect(context.aiCommandPlanner.plan).not.toHaveBeenCalled();
    expect(context.ai.askMessages).not.toHaveBeenCalledWith(expect.objectContaining({ usageScope: 'summary' }));
    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '대화 내용 요약해봐');
  });

  it('asks for clarification when AgentRuntime sees a cleanup request without count or scope', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({ kind: 'clarify', message: '서버닉님의 채팅을 지울까요, 아니면 채널 전체 채팅을 지울까요? 지울 개수도 같이 알려 주세요. 예: 채팅 10개 지워줘' }))
      }
    });
    const message = makeMessage('!? 채팅 지워줘', {
      member: {
        displayName: '서버닉',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });
    const cleanupChannel = message.channel as any;
    cleanupChannel.bulkDelete = vi.fn(async () => new Collection());

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(cleanupChannel.bulkDelete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('서버닉님의 채팅을 지울까요')
    }));
  });

  it('turns AgentRuntime structured cleanup confirmations into pending confirmations before deletion', async () => {
    const commands = createPrefixCommands();
    const confirmations = new ConfirmationManager();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({
          kind: 'confirmation_required',
          message: '청소 전 확인이 필요해요...',
          intent: 'command.cleanup',
          preview: 'Confirm command.cleanup',
          commandQuery: '청소 2',
          payload: { target: 'self', count: 2, evidence: '내 채팅' }
        }))
      }
    });
    const message = makeMessage('!? 채팅 2개 지워줘');
    const cleanupChannel = message.channel as any;
    cleanupChannel.messages = {
      fetch: vi.fn(async () =>
        new Collection([
          ['cmd', { id: 'cmd', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['1', { id: '1', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }],
          ['2', { id: '2', author: { id: 'user-1' }, createdTimestamp: Date.now(), delete: vi.fn(async () => undefined) }]
        ])
      )
    };
    cleanupChannel.bulkDelete = vi.fn(async (items: any[]) => new Collection(items.map((item) => [item.id, item])));

    await handleMessageCreate(message, commands, context as any, confirmations);

    expect(cleanupChannel.bulkDelete).not.toHaveBeenCalled();
    expect(confirmations.latestForActor({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toMatchObject({
      intent: 'cleanup',
      commandQuery: '청소 2'
    });
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('AI 확인 안내')
    }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('blocks AgentRuntime structured admin confirmations before creating pending work for non-admins', async () => {
    const commands = createPrefixCommands();
    const confirmations = new ConfirmationManager();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({
          kind: 'confirmation_required',
          message: '웹 검색 모드 변경 전 확인이 필요해요...',
          intent: 'settings.web_search',
          preview: 'Confirm settings.web_search',
          commandQuery: '웹검색 automatic',
          payload: { mode: 'automatic' }
        }))
      }
    });
    const message = makeMessage('!? 웹검색 automatic으로 바꿔줘');

    await handleMessageCreate(message, commands, context as any, confirmations);

    expect(confirmations.latestForActor({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toBeUndefined();
    expect(context.voiceSettings.getGuildWebSearchMode('guild-1')).toBeUndefined();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('서버 관리자만')
    }));
  });

  it('falls back from AgentRuntime not_handled to chat without natural-language command execution', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      agentRuntime: {
        run: vi.fn(async () => ({ kind: 'not_handled' }))
      }
    });
    const message = makeMessage('!? 들어와');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.join).not.toHaveBeenCalled();
    expect(context.aiChat.handlePrompt).toHaveBeenCalledWith(message, '들어와');
  });

  it('shows and changes guild web-search mode with administrator-only command mutations', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();

    const show = makeMessage('!웹검색 현재');
    await handleMessageCreate(show, commands, context as any, new ConfirmationManager());
    expect(show.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('현재 웹 검색 모드: search_first_factual')
    }));

    const denied = makeMessage('!웹검색 disabled');
    await handleMessageCreate(denied, commands, context as any, new ConfirmationManager());
    expect(context.voiceSettings.getGuildWebSearchMode('guild-1')).toBeUndefined();
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('서버 관리자만 웹 검색 모드를 바꿀 수 있어요')
    }));

    const admin = makeMessage('!웹검색 automatic', {
      member: {
        displayName: '관리자',
        permissions: { has: vi.fn(() => true) },
        voice: { channel: { id: 'voice-1' } }
      }
    });
    await handleMessageCreate(admin, commands, context as any, new ConfirmationManager());
    expect(context.voiceSettings.getGuildWebSearchMode('guild-1')).toBe('automatic');
    expect(admin.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('automatic')
    }));
  });

  it('routes natural-language web-search mode changes through confirmation before mutating settings', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const confirmations = new ConfirmationManager();
    const adminMember = {
      displayName: '관리자',
      permissions: { has: vi.fn(() => true) },
      voice: { channel: { id: 'voice-1' } }
    };

    const first = makeMessage('!? 웹검색 disabled', { member: adminMember });
    await handleMessageCreate(first, commands, context as any, confirmations);

    expect(context.voiceSettings.getGuildWebSearchMode('guild-1')).toBeUndefined();
    expect(confirmations.latestForActor({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toMatchObject({
      intent: 'web-search',
      preview: '웹 검색 모드를 바꿀까요?',
      commandQuery: '웹검색 disabled'
    });
    expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('AI 확인 안내')
    }));

    context.agentRuntime = {
      run: vi.fn(async () => ({ kind: 'confirm_pending' }))
    } as any;
    const second = makeMessage('!? ㅇㅇ', { id: 'message-2', member: adminMember });
    await handleMessageCreate(second, commands, context as any, confirmations);

    expect(context.voiceSettings.getGuildWebSearchMode('guild-1')).toBe('disabled');
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('disabled')
    }));
  });

  it('falls through to watched-channel TTS when neither prefix nor AI applies', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('그냥 인사');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.enqueueMessage).toHaveBeenCalledWith(message);
    expect(context.activityLog.logTtsRequest).toHaveBeenCalledTimes(1);
  });
});
