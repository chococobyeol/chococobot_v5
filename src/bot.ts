import { ChannelType, Client, Collection, Events, GatewayIntentBits, GuildMember } from 'discord.js';
import type { GuildTextBasedChannel, Message, TextChannel } from 'discord.js';
import type { PrefixCommand } from './types.js';
import type { Settings } from './config.js';
import type { UsageStore } from './services/usageStore.js';
import { AiService } from './services/aiService.js';
import { BotActivityLogService } from './services/botActivityLogService.js';
import { SqliteBotActivityLogStore } from './services/botActivityLogStore.js';
import { normalizeTtsEngineName, TtsService } from './services/ttsService.js';
import { VoiceService } from './services/voiceService.js';
import {
  cleanupChannelMessages,
  cleanupUserMessages,
  formatCleanupResult,
  hasManageMessages,
  type CleanupFetchableChannel
} from './services/cleanupService.js';
import { logger } from './logger.js';

const PREFIX = '!';

export type BotContext = {
  settings: Settings;
  usageStore: UsageStore;
  ai: AiService;
  voice: VoiceService;
  activityLog: BotActivityLogService;
};

type ParsedPrefixCommand = {
  name: string;
  args: string[];
};

export function parsePrefixCommand(content: string): ParsedPrefixCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  const withoutPrefix = trimmed.slice(PREFIX.length).trim();
  if (!withoutPrefix) return null;
  const [rawName, ...args] = withoutPrefix.split(/\s+/);
  return { name: rawName.toLowerCase(), args };
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

function requireGuildTextChannel(message: Message): TextChannel {
  const channel = message.channel;
  if (channel.type !== ChannelType.GuildText) throw new Error('서버 텍스트 채널에서만 사용할 수 있어요...');
  return channel;
}

function resolveTargetGuildTextChannel(message: Message, rawChannel?: string): GuildTextBasedChannel {
  if (!rawChannel) return requireGuildTextChannel(message);

  const mentioned = message.mentions.channels.first();
  if (mentioned?.type === ChannelType.GuildText) return mentioned;

  const channelId = rawChannel.trim().replace(/^<#/, '').replace(/>$/, '');
  const channel = message.guild?.channels.cache.get(channelId);
  if (channel?.type === ChannelType.GuildText) return channel;

  throw new Error('설정할 텍스트 채널을 찾을 수 없어요... `!tts채널 #채널`처럼 입력해 주세요...');
}

function requireGuildMember(message: Message): GuildMember {
  if (!message.member) throw new Error('서버 멤버 정보가 필요해요...');
  return message.member as GuildMember;
}

function registerPrefixCommand(commands: Collection<string, PrefixCommand>, command: PrefixCommand): void {
  commands.set(command.name, command);
  for (const alias of command.aliases) commands.set(alias.toLowerCase(), command);
}

function summarizeCommandForLog(commandName: string, args: string[]): string {
  const joined = args.join(' ').trim();
  switch (commandName) {
    case '말':
    case 'say':
    case 'tts-say':
    case '말해':
      return `text=${joined.slice(0, 500)}`;
    case '청소':
    case 'clean':
    case 'clean-mine':
    case '내청소':
    case '대청소':
    case 'clean-all':
    case 'purge':
      return `target=${args[0] ?? 'default'}`;
    case 'tts채널':
    case 'tts-channel':
    case 'tts-watch':
    case 'watch':
    case '채널tts':
      return `action=${args[0] ?? 'set-current'}`;
    case '음색':
    case 'voice':
    case 'tts-voice':
    case '목소리':
      return `preset=${args[0] ?? 'show'}`;
    case 'tts엔진':
    case 'tts-engine':
    case 'engine':
    case '엔진':
      return `engine=${args[0] ?? 'show'}`;
    default:
      return `args=${args.join('|').slice(0, 200)}`;
  }
}

export function createPrefixCommands(): Collection<string, PrefixCommand> {
  const commands = new Collection<string, PrefixCommand>();

  const definitions: PrefixCommand[] = [
    {
      name: '청소',
      aliases: ['clean', 'clean-mine', '내청소'],
      description: '내가 쓴 최근 메시지를 삭제합니다.',
      async execute(message, args, context) {
        const channel = requireGuildTextChannel(message);
        const amount = parseOptionalPositiveInt(args[0]);
        const result = await cleanupUserMessages(channel as CleanupFetchableChannel, message.author.id, {
          target: amount,
          defaultTarget: context.settings.cleanMineDefaultTarget,
          maxTarget: context.settings.cleanMineMaxLimit
        });
        await channel.send({ content: formatCleanupResult('내 메시지', result), allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '대청소',
      aliases: ['clean-all', 'purge'],
      description: '관리자용: 최근 채팅을 삭제합니다.',
      async execute(message, args, context) {
        const channel = requireGuildTextChannel(message);
        if (!hasManageMessages(message.member?.permissions)) {
          throw new Error('Manage Messages 권한이 필요해요.');
        }
        const amount = parseOptionalPositiveInt(args[0]);
        const result = await cleanupChannelMessages(channel as CleanupFetchableChannel, {
          target: amount,
          defaultTarget: context.settings.cleanAllDefaultTarget,
          maxTarget: context.settings.cleanAllMaxLimit
        });
        await channel.send({ content: formatCleanupResult('최근 메시지', result), allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '들어와',
      aliases: ['join', 'tts-join', '이리와', 'come', '여기와'],
      description: '내 음성 채널에 봇을 연결합니다.',
      async execute(message, _args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        await context.voice.join(requireGuildMember(message));
        await context.activityLog.logVoiceConnection({
          guildId: message.guildId,
          guildName: message.guild?.name,
          channelId: message.member?.voice.channel?.id,
          message: 'voice joined'
        });
        await message.reply({ content: '음성 채널에 연결했어요...', allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '나가',
      aliases: ['leave', 'tts-leave', '꺼져', '저리가', 'go', 'out', '퇴장'],
      description: '봇을 음성 채널에서 내보냅니다.',
      async execute(message, _args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        context.voice.leave(message.guildId);
        await context.activityLog.logVoiceConnection({
          guildId: message.guildId,
          guildName: message.guild?.name,
          message: 'voice left'
        });
        await message.reply({ content: '음성 채널에서 나왔어요...', allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: 'tts채널',
      aliases: ['tts-channel', 'tts-watch', 'watch', '채널tts'],
      description: 'TTS가 읽을 텍스트 채널을 설정하거나 해제합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const action = args[0]?.trim();
        if (!action) {
          context.voice.setWatchedChannel(message.guildId, message.channelId, true);
          await message.reply({
            content: `<#${message.channelId}>를 TTS 채널로 설정했어요...`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        const normalized = action.toLowerCase();
        if (['현재', 'status', 'show', 'info', '조회'].includes(normalized)) {
          const watchedChannelId = context.voice.getWatchedChannelId(message.guildId);
          await message.reply({
            content: watchedChannelId ? `현재 TTS 채널은 <#${watchedChannelId}>예요...` : '현재 설정된 TTS 채널이 없어요...',
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        if (['해제', '끄기', 'off', 'disable', 'unset', 'clear', 'none', '없음', '초기화'].includes(normalized)) {
          const watchedChannelId = context.voice.getWatchedChannelId(message.guildId);
          context.voice.setWatchedChannel(message.guildId, watchedChannelId ?? message.channelId, false);
          await message.reply({ content: 'TTS 채널 설정을 해제했어요...', allowedMentions: { repliedUser: false } });
          return;
        }

        const channel = resolveTargetGuildTextChannel(message, action);
        context.voice.setWatchedChannel(message.guildId, channel.id, true);
        await message.reply({ content: `<#${channel.id}>를 TTS 채널로 설정했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '말',
      aliases: ['말해', 'say', 'tts-say'],
      description: '지정한 문장을 음성 채널에서 읽습니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const text = args.join(' ').trim();
        if (!text) throw new Error('읽을 문장을 입력해 주세요...');
        if (!context.voice.isConnected(message.guildId)) {
          const member = requireGuildMember(message);
          if (!member.voice.channel) throw new Error('먼저 음성 채널에 들어가 주세요...');
          await context.voice.join(member);
          await context.activityLog.logVoiceConnection({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: member.voice.channel.id,
            message: 'voice auto-joined for tts'
          });
        }
        await context.activityLog.logTtsRequest({
          guildId: message.guildId,
          guildName: message.guild?.name,
          channelId: message.channelId,
          userId: message.author.id,
          userName: message.author.username,
          source: 'command',
          engine: context.voice.getUserTtsEngine(message.guildId, message.author.id),
          voice: context.voice.getUserVoicePreset(message.guildId, message.author.id),
          text
        });
        const played = await context.voice.speak(message.guildId, text, message.author.id);
        if (played) {
          await message.reply({ content: '읽기 요청을 추가했어요...', allowedMentions: { repliedUser: false } });
        } else {
          await context.activityLog.logError({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: message.author.username,
            commandName: '말',
            summary: `text=${text.slice(0, 500)}`,
            error: new Error('TTS synthesis/playback failed')
          });
        }
      }
    },
    {
      name: '음색',
      aliases: ['voice', 'tts-voice', '목소리'],
      description: '내 TTS 음색 프리셋을 확인하거나 설정합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const preset = args[0]?.toLowerCase();
        if (!preset) {
          const presets = context.voice.listVoicePresets();
          const current = context.voice.getUserVoicePreset(message.guildId, message.author.id) ?? '기본값';
          await message.reply({
            content: [`현재 음색: ${current}`, `사용 가능: ${presets.join(', ')}`, '`!음색 sunhi`처럼 설정해 주세요...'].join('\n'),
            allowedMentions: { repliedUser: false }
          });
          return;
        }
        context.voice.setUserVoicePreset(message.guildId, message.author.id, preset);
        await message.reply({ content: `내 TTS 음색을 ${preset}로 저장했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: 'tts엔진',
      aliases: ['tts-engine', 'engine', '엔진'],
      description: '내 TTS 엔진을 확인하거나 설정합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const raw = args[0]?.trim();
        if (!raw) {
          const current = context.voice.getUserTtsEngine(message.guildId, message.author.id);
          await message.reply({
            content: [`현재 엔진: ${current}`, `사용 가능: ${context.voice.listTtsEngines().join(', ')}`, '`!tts엔진 edge` 또는 `!tts엔진 gtts`처럼 설정해 주세요...'].join('\n'),
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        const normalized = raw.toLowerCase();
        if (['해제', '기본', 'default', 'reset', 'clear', 'none'].includes(normalized)) {
          context.voice.clearUserTtsEngine(message.guildId, message.author.id);
          await message.reply({ content: 'TTS 엔진 설정을 기본값으로 되돌렸어요...', allowedMentions: { repliedUser: false } });
          return;
        }

        const engine = normalizeTtsEngineName(raw);
        if (!engine) {
          throw new Error(`알 수 없는 TTS 엔진이에요. 사용 가능: ${context.voice.listTtsEngines().join(', ')}`);
        }
        context.voice.setUserTtsEngine(message.guildId, message.author.id, engine);
        await message.reply({ content: `내 TTS 엔진을 ${engine}로 저장했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '도움말',
      aliases: ['help', 'commands'],
      description: '사용 가능한 명령어를 보여줍니다.',
      async execute(message) {
        await message.reply({
          content: [
            '`!청소 [개수]` — 내 최근 메시지 삭제...',
            '`!대청소 [개수]` — 관리자용 채널 메시지 삭제...',
            '`!들어와` / `!이리와` / `!나가` / `!꺼져` / `!저리가` — 음성 채널 연결/해제...',
            '`!tts채널 [#채널|해제]` — 채널 TTS 읽기 설정/해제...',
            '`!말 <문장>` — 문장을 음성으로 읽기...',
            '`!음색 [프리셋]` — 내 TTS 음색 확인/설정...',
            '`!tts엔진 [edge|gtts]` — 내 TTS 엔진 확인/설정...'
          ].join('\n'),
          allowedMentions: { repliedUser: false }
        });
      }
    }
  ];

  for (const command of definitions) registerPrefixCommand(commands, command);
  return commands;
}

async function dispatchPrefixCommand(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext
): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guildId) return false;
  const parsed = parsePrefixCommand(message.content);
  if (!parsed) return false;
  const command = commands.get(parsed.name);
  if (!command) {
    await message.reply({ content: '`!도움말`로 사용 가능한 명령어를 확인해 주세요...', allowedMentions: { repliedUser: false } });
    return true;
  }
  const commandSummary = summarizeCommandForLog(command.name, parsed.args);
  await context.activityLog.logCommand({
    guildId: message.guildId,
    guildName: message.guild?.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: message.author.username,
    commandName: command.name,
    summary: commandSummary
  });
  try {
    await command.execute(message, parsed.args, context);
  } catch (error) {
    logger.error(error);
    await context.activityLog.logError({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.author.username,
      commandName: command.name,
      summary: commandSummary,
      error
    });
    const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류가 발생했어요...';
    await message.reply({ content: errorMessage, allowedMentions: { repliedUser: false } });
  }
  return true;
}

export async function createBot(
  settings: Settings,
  options: { bootstrapLogging?: boolean } = {}
): Promise<{ client: Client; context: BotContext; commands: Collection<string, PrefixCommand> }> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent
    ]
  });

  const { UsageStore } = await import('./services/usageStore.js');
  const { SqliteVoiceSettingsStore } = await import('./services/voiceSettingsStore.js');
  const usageStore = new UsageStore(settings.databasePath);
  const activityLog = new BotActivityLogService(client, new SqliteBotActivityLogStore(settings.databasePath), settings.loggingGuildId);
  const context: BotContext = {
    settings,
    usageStore,
    ai: new AiService(settings, usageStore),
    activityLog,
    voice: new VoiceService(
      new TtsService(settings.ttsVoice, settings.ttsMaxChars),
      new SqliteVoiceSettingsStore(settings.databasePath),
      settings.ttsVoicePresets,
      settings.ttsEngine as 'edge' | 'gtts',
      settings.voiceIdleLeaveMs
    )
  };
  const commands = createPrefixCommands();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    if (options.bootstrapLogging !== false) {
      void activityLog.ensureLayoutForCurrentGuilds();
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    void activityLog.ensureGuildLogChannel(guild.id);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (await dispatchPrefixCommand(message, commands, context)) return;
    if (!message.guildId) return;
    if (message.author.bot && !settings.ttsReadBotMessages) return;
    const queued = await context.voice.enqueueMessage(message);
    if (queued) {
      await context.activityLog.logTtsRequest({
        guildId: message.guildId,
        guildName: message.guild?.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName: message.author.username,
        source: 'watched-channel',
        engine: context.voice.getUserTtsEngine(message.guildId, message.author.id),
        voice: context.voice.getUserVoicePreset(message.guildId, message.author.id),
        textLength: message.cleanContent.length
      });
    }
  });

  return { client, context, commands };
}
