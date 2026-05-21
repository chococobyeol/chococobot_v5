import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createPrefixCommands } from '../src/bot.js';
import { TtsService } from '../src/services/ttsService.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';
import { VoiceService } from '../src/services/voiceService.js';

function makeContext() {
  const store = new InMemoryVoiceSettingsStore();
  return {
    voice: new VoiceService(new TtsService('ko-KR-SunHiNeural', 180), store, {
      sunhi: 'ko-KR-SunHiNeural',
      injoon: 'ko-KR-InJoonNeural',
      bright: 'ko-KR-SunHiNeural',
      calm: 'ko-KR-InJoonNeural'
    }, 'edge', 1_000)
  };
}

function makeMessage(channelId = 'channel-1', mentionChannel?: { id: string; type: ChannelType }) {
  const reply = vi.fn(async () => undefined);
  const channel = { id: channelId, type: ChannelType.GuildText };
  const entries: Array<readonly [string, { id: string; type: ChannelType }]> = [[channelId, channel]];
  if (mentionChannel) entries.push([mentionChannel.id, mentionChannel]);
  const guild = {
    channels: {
      cache: new Map(entries)
    }
  };

  return {
    guildId: 'guild-1',
    channelId,
    channel,
    guild,
    mentions: {
      channels: {
        first: vi.fn(() => mentionChannel ?? null)
      }
    },
    reply,
    author: { id: 'user-1', bot: false },
    member: { permissions: null }
  } as any;
}

describe('tts채널 prefix command', () => {
  it('sets, shows, and clears the watched channel per guild', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('tts채널');
    expect(command).toBeDefined();

    const context = makeContext();
    const message = makeMessage('channel-1');

    await command!.execute(message, [], context as any);
    expect(context.voice.getWatchedChannelId('guild-1')).toBe('channel-1');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '<#channel-1>를 TTS 채널로 설정했어요.' }));

    const currentMessage = makeMessage('channel-1');
    await command!.execute(currentMessage, ['현재'], context as any);
    expect(currentMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '현재 TTS 채널은 <#channel-1>예요.' }));

    const clearMessage = makeMessage('channel-1');
    await command!.execute(clearMessage, ['해제'], context as any);
    expect(context.voice.getWatchedChannelId('guild-1')).toBeUndefined();
    expect(clearMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'TTS 채널 설정을 해제했어요.' }));

    const targetMessage = makeMessage('channel-1', { id: 'channel-2', type: ChannelType.GuildText });
    await command!.execute(targetMessage, ['channel-2'], context as any);
    expect(context.voice.getWatchedChannelId('guild-1')).toBe('channel-2');
    expect(targetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '<#channel-2>를 TTS 채널로 설정했어요.' }));
  });
});

describe('tts엔진 prefix command', () => {
  it('sets, shows, and clears the stored tts engine per guild/user', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('tts엔진');
    expect(command).toBeDefined();

    const context = makeContext();
    const message = makeMessage('channel-1');

    await command!.execute(message, [], context as any);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('현재 엔진: edge') }));

    const setMessage = makeMessage('channel-1');
    await command!.execute(setMessage, ['구글'], context as any);
    expect(context.voice.getUserTtsEngine('guild-1', 'user-1')).toBe('gtts');
    expect(setMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '내 TTS 엔진을 gtts로 저장했어요.' }));

    const resetMessage = makeMessage('channel-1');
    await command!.execute(resetMessage, ['해제'], context as any);
    expect(context.voice.getUserTtsEngine('guild-1', 'user-1')).toBe('edge');
    expect(resetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'TTS 엔진 설정을 기본값으로 되돌렸어요.' }));
  });
});

describe('말 prefix command', () => {
  it('auto-joins the caller voice channel before speaking when not connected', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('말');
    expect(command).toBeDefined();

    const join = vi.fn(async () => undefined);
    const speak = vi.fn(async () => true);
    const message = makeMessage('channel-1') as any;
    message.member = {
      voice: { channel: { id: 'voice-1' } },
      displayName: '테스터'
    };
    const context = {
      voice: {
        isConnected: vi.fn(() => false),
        join,
        speak,
        getUserTtsEngine: vi.fn(() => 'edge'),
        getUserVoicePreset: vi.fn(() => 'sunhi')
      },
      activityLog: {
        logVoiceConnection: vi.fn(async () => undefined),
        logTtsRequest: vi.fn(async () => undefined),
        logCommand: vi.fn(async () => undefined),
        logError: vi.fn(async () => undefined)
      }
    };

    await command!.execute(message, ['안녕'], context as any);

    expect(join).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('guild-1', '안녕', 'user-1');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '읽기 요청을 추가했어요.' }));
  });
});
