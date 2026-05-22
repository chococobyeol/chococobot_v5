import { ChannelType, Collection } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createPrefixCommands, handleMessageCreate } from '../src/bot.js';
import { ConfirmationManager } from '../src/services/confirmationManager.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';

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
      cleanAllMaxLimit: 1000
    },
    voiceSettings,
    aiChat: {
      handlePrompt: vi.fn(async () => true),
      resetGuildMemory: vi.fn(async () => undefined)
    },
    ai: {
      askMessages: vi.fn(async () => '채널 기록 답변')
    },
    voice: {
      enqueueMessage: vi.fn(async () => true),
      join: vi.fn(async () => undefined),
      leave: vi.fn(() => undefined),
      speak: vi.fn(async () => true),
      stopPlayback: vi.fn(() => true),
      getUserTtsEngine: vi.fn(() => 'edge'),
      getUserVoicePreset: vi.fn(() => 'sunhi'),
      isConnected: vi.fn(() => false)
    },
    activityLog: {
      logCommand: vi.fn(async () => undefined),
      logCleanupResult: vi.fn(async () => undefined),
      logChannelHistory: vi.fn(async () => undefined),
      logError: vi.fn(async () => undefined),
      logTtsRequest: vi.fn(async () => undefined),
      logVoiceConnection: vi.fn(async () => undefined),
      logAiDiagnostic: vi.fn(async () => undefined)
    },
    ...overrides
  } as any;
}

describe('handleMessageCreate', () => {
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
      requested: 4,
      deleted: 4,
      matched: 4,
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
      content: '서버닉님의 요청으로 메시지 4개를 삭제했어요...',
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
      requested: 4,
      deleted: 4,
      matched: 4,
      skippedOld: 0,
      exhausted: true
    });
    expect(message.reply).not.toHaveBeenCalled();
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
        content: expect.stringContaining('확인 토큰')
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
    const message = makeMessage('!? 모든 채팅 지워줘');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('확인 토큰')
      })
    );
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

  it('remembers a pending channel-history clarification and uses the next channel answer', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
      }
    });
    const memoChannel = {
      id: 'memo-2',
      name: '메모채널',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async () =>
          [
            {
              id: 'memo-message-1',
              channelId: 'memo-2',
              createdTimestamp: Date.now(),
              content: '메모 내용',
              author: { id: 'user-2', username: 'writer', bot: false },
              member: { displayName: '작성자' }
            }
          ] as any
        )
      }
    };
    const first = makeMessage('!? 없는채널 내용 요약해줘');
    const second = makeMessage('!? 메모 채널');
    first.guild.channels.cache.set('memo-2', memoChannel);
    second.guild.channels.cache.set('memo-2', memoChannel);

    await handleMessageCreate(first, commands, context as any, new ConfirmationManager());
    await handleMessageCreate(second, commands, context as any, new ConfirmationManager());

    expect(first.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('어느 채널을 요약할지')
      })
    );
    expect(second.reply).toHaveBeenCalledWith(
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
  });

  it('summarizes recent conversations across text channels when no channel is specified', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
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
        plan: vi.fn(async () => ({ kind: 'chat' }))
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

  it('does not summarize unrelated recent history when a topic lookup has no matches', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
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

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '정성카츠에 관한 내용은 최근 대화에서 찾지 못했어요...' }));
    expect(context.ai.askMessages).not.toHaveBeenCalled();
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '정성카츠',
      matchedMessages: 0
    }));
    expect(context.aiChat.handlePrompt).not.toHaveBeenCalled();
  });

  it('lets AI judge fuzzy topic searches using recent history instead of exact-match rejecting them', async () => {
    const commands = createPrefixCommands();
    const context = makeContext({
      aiCommandPlanner: {
        plan: vi.fn(async () => ({ kind: 'chat' }))
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
          expect.objectContaining({ content: expect.stringContaining('검색 주제: 파스타') }),
          expect.objectContaining({ content: expect.stringContaining('스파게티 먹자는 얘기가 있었어요') })
        ])
      })
    );
    expect(context.activityLog.logChannelHistory).toHaveBeenCalledWith(expect.objectContaining({
      topic: '파스타',
      matchedMessages: 0,
      usedMessages: 1
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
