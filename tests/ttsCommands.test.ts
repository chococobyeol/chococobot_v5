import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createPrefixCommands } from '../src/bot.js';
import { TtsService } from '../src/services/ttsService.js';
import { InMemoryVoiceSettingsStore } from '../src/services/voiceSettingsStore.js';
import { VoiceService } from '../src/services/voiceService.js';

function makeContext() {
  const store = new InMemoryVoiceSettingsStore();
  return {
    settings: { botTimeZone: 'Asia/Seoul' },
    voiceSettings: store,
    voice: new VoiceService(new TtsService('ko-KR-SunHiNeural', 500), store, {
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
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '<#channel-1>를 TTS 채널로 설정했어요...' }));

    const currentMessage = makeMessage('channel-1');
    await command!.execute(currentMessage, ['현재'], context as any);
    expect(currentMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '현재 TTS 채널은 <#channel-1>예요...' }));

    const clearMessage = makeMessage('channel-1');
    await command!.execute(clearMessage, ['해제'], context as any);
    expect(context.voice.getWatchedChannelId('guild-1')).toBeUndefined();
    expect(clearMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'TTS 채널 설정을 해제했어요...' }));

    const targetMessage = makeMessage('channel-1', { id: 'channel-2', type: ChannelType.GuildText });
    await command!.execute(targetMessage, ['channel-2'], context as any);
    expect(context.voice.getWatchedChannelId('guild-1')).toBe('channel-2');
    expect(targetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '<#channel-2>를 TTS 채널로 설정했어요...' }));
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
    expect(setMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '내 TTS 엔진을 gtts로 저장했어요...' }));

    const resetMessage = makeMessage('channel-1');
    await command!.execute(resetMessage, ['해제'], context as any);
    expect(context.voice.getUserTtsEngine('guild-1', 'user-1')).toBe('edge');
    expect(resetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'TTS 엔진 설정을 기본값으로 되돌렸어요...' }));
  });
});


describe('시간대 prefix command', () => {
  it('sets, shows, and clears the stored user time zone', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('시간대');
    expect(command).toBeDefined();

    const context = makeContext();
    const message = makeMessage('channel-1');

    await command!.execute(message, [], context as any);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '내 시간대가 아직 없어요... 지금 시간 질문은 Asia/Seoul 기준으로 답해요...' }));

    const setMessage = makeMessage('channel-1');
    await command!.execute(setMessage, ['America/Los_Angeles'], context as any);
    expect(context.voiceSettings.getUserTimeZone('guild-1', 'user-1')).toBe('America/Los_Angeles');
    expect(setMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '내 시간대를 America/Los_Angeles로 저장했어요...' }));

    const resetMessage = makeMessage('channel-1');
    await command!.execute(resetMessage, ['해제'], context as any);
    expect(context.voiceSettings.getUserTimeZone('guild-1', 'user-1')).toBeUndefined();
    expect(resetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '시간대 설정을 지웠어요... 이제 Asia/Seoul 기준으로 답해요...' }));
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
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('rejects overly long text with a clear limit message', async () => {
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
      settings: { ttsMaxChars: 500 },
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

    await expect(command!.execute(message, ['가'.repeat(501)], context as any)).rejects.toThrow('한 번에 500자까지만 읽을 수 있어요...');
    expect(join).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('멈춰 prefix command', () => {
  it('stops current playback and clears the queue', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('멈춰');
    expect(command).toBeDefined();

    const stopPlayback = vi.fn(() => true);
    const message = makeMessage('channel-1') as any;
    const context = {
      voice: {
        isConnected: vi.fn(() => true),
        stopPlayback
      },
      activityLog: {
        logVoiceConnection: vi.fn(async () => undefined),
        logTtsRequest: vi.fn(async () => undefined),
        logCommand: vi.fn(async () => undefined),
        logError: vi.fn(async () => undefined)
      }
    };

    await command!.execute(message, [], context as any);

    expect(stopPlayback).toHaveBeenCalledWith('guild-1');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '재생을 멈췄어요...' }));
  });
});

describe('도움말 prefix command', () => {
  it('responds to !명령어 as an alias for help', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('명령어');
    expect(command).toBeDefined();

    const message = makeMessage('channel-1');
    const context = makeContext();

    await command!.execute(message, [], context as any);

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('현재 프리픽스는 `!`예요...')
      })
    );
  });
});

describe('프리픽스 prefix command', () => {
  it('lets server administrators change and reset the guild prefix', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('프리픽스');
    expect(command).toBeDefined();

    const message = makeMessage('channel-1') as any;
    message.member = {
      permissions: {
        has: vi.fn((permission: bigint) => permission === PermissionFlagsBits.Administrator)
      }
    };

    const context = makeContext();

    await command!.execute(message, [], context as any);
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('현재 프리픽스는 `!`예요...')
      })
    );

    const setMessage = makeMessage('channel-1') as any;
    setMessage.member = message.member;
    await command!.execute(setMessage, ['?'], context as any);
    expect(context.voiceSettings.getCommandPrefix('guild-1')).toBe('?');
    expect(setMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '프리픽스를 `?`로 저장했어요...' }));

    const resetMessage = makeMessage('channel-1') as any;
    resetMessage.member = message.member;
    await command!.execute(resetMessage, ['해제'], context as any);
    expect(context.voiceSettings.getCommandPrefix('guild-1')).toBeUndefined();
    expect(resetMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '프리픽스를 기본값으로 되돌렸어요... 이제 `!`를 사용해요...' }));
  });

  it('rejects non-administrators', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('프리픽스');
    expect(command).toBeDefined();

    const message = makeMessage('channel-1') as any;
    message.member = {
      permissions: {
        has: vi.fn(() => false)
      }
    };
    const context = makeContext();

    await expect(command!.execute(message, ['?'], context as any)).rejects.toThrow('서버 관리자만 프리픽스를 바꿀 수 있어요...');
  });
});

describe('기억삭제 prefix command', () => {
  it('lets server administrators reset guild AI memory', async () => {
    const commands = createPrefixCommands();
    const command = commands.get('기억삭제');
    expect(command).toBeDefined();

    const resetGuildMemory = vi.fn(async () => undefined);
    const message = makeMessage('channel-1') as any;
    message.member = {
      permissions: {
        has: vi.fn((permission: bigint) => permission === PermissionFlagsBits.Administrator)
      }
    };
    const context = {
      aiChat: {
        resetGuildMemory
      }
    };

    await command!.execute(message, [], context as any);

    expect(resetGuildMemory).toHaveBeenCalledWith('guild-1');
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: '서버 AI 기억을 지웠어요...' }));
  });
});
