import { ChannelType } from 'discord.js';
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
      ttsMaxChars: 500
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
      logError: vi.fn(async () => undefined),
      logTtsRequest: vi.fn(async () => undefined),
      logVoiceConnection: vi.fn(async () => undefined)
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

  it('falls through to watched-channel TTS when neither prefix nor AI applies', async () => {
    const commands = createPrefixCommands();
    const context = makeContext();
    const message = makeMessage('그냥 인사');

    await handleMessageCreate(message, commands, context as any, new ConfirmationManager());

    expect(context.voice.enqueueMessage).toHaveBeenCalledWith(message);
    expect(context.activityLog.logTtsRequest).toHaveBeenCalledTimes(1);
  });
});
