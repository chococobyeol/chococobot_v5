import { ChannelType, Client, Collection, Events, GatewayIntentBits, GuildMember, PermissionFlagsBits } from 'discord.js';
import type { GuildTextBasedChannel, Message, TextChannel } from 'discord.js';
import type { PrefixCommand } from './types.js';
import type { Settings } from './config.js';
import type { UsageStore } from './services/usageStore.js';
import { AiService } from './services/aiService.js';
import { extractErrorDetails, type AiChatMessage } from './services/aiService.js';
import { AiCommandPlanner } from './services/aiCommandPlanner.js';
import { AiChatService, parseAiChatTrigger } from './services/aiChatService.js';
import { BotActivityLogService } from './services/botActivityLogService.js';
import { ConfirmationManager, type ConfirmationScope } from './services/confirmationManager.js';
import {
  DEFAULT_HISTORY_LOOKBACK_HOURS,
  DEFAULT_HISTORY_MESSAGE_LIMIT,
  MAX_HISTORY_LOOKBACK_HOURS,
  MAX_HISTORY_MESSAGE_LIMIT,
  assessChannelHistoryQuery,
  fetchChannelHistory,
  searchGuildMessages
} from './services/channelHistoryService.js';
import { SqliteBotActivityLogStore } from './services/botActivityLogStore.js';
import { SqliteAiMemoryStore } from './services/aiMemoryStore.js';
import { routeNaturalLanguageCommand, type RoutedNaturalLanguageCommand } from './services/nlCommandRouter.js';
import { buildUnavailableVoiceMessage, classifyCommandQuery, type CommandSafety } from './services/commandSafety.js';
import { normalizeTtsEngineName, TtsService } from './services/ttsService.js';
import { VoiceService } from './services/voiceService.js';
import {
  cleanupChannelMessages,
  cleanupUserMessages,
  hasManageMessages,
  type CleanupFetchableChannel
} from './services/cleanupService.js';
import { logger } from './logger.js';

const DEFAULT_PREFIX = '!';
const ALLOWED_PREFIXES = ['!', '?', '.', '~'] as const;
const MAX_TTS_COMMAND_CHARS = 500;
const CLEANUP_COMMAND_MESSAGE_EXTRA_COUNT = 1;
const PENDING_CHANNEL_HISTORY_TTL_MS = 5 * 60 * 1000;
const MAX_AUTO_HISTORY_CHANNELS = 20;

type PendingChannelHistoryRequest = {
  mode: 'summary' | 'qa';
  query: string;
  createdAt: number;
};

const pendingChannelHistoryRequests = new Map<string, PendingChannelHistoryRequest>();

export function clearPendingChannelHistoryRequestsForTests(): void {
  pendingChannelHistoryRequests.clear();
}

export type BotContext = {
  settings: Settings;
  usageStore: UsageStore;
  ai: AiService;
  aiChat: AiChatService;
  aiCommandPlanner?: AiCommandPlanner;
  voice: VoiceService;
  voiceSettings: import('./services/voiceSettingsStore.js').VoiceSettingsStore;
  activityLog: BotActivityLogService;
};

type ParsedPrefixCommand = {
  name: string;
  args: string[];
};

export function parsePrefixCommand(content: string, prefix = DEFAULT_PREFIX): ParsedPrefixCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const withoutPrefix = trimmed.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [rawName, ...args] = withoutPrefix.split(/\s+/);
  return { name: rawName.toLowerCase(), args };
}

function getGuildPrefix(context: BotContext, guildId?: string): string {
  if (!guildId) return DEFAULT_PREFIX;
  return context.voiceSettings.getCommandPrefix(guildId) ?? DEFAULT_PREFIX;
}

function isAllowedPrefix(prefix: string): prefix is (typeof ALLOWED_PREFIXES)[number] {
  return (ALLOWED_PREFIXES as readonly string[]).includes(prefix);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

function includeInvokingCleanupCommandTarget(target: number | undefined): number | undefined {
  return target === undefined ? undefined : target + CLEANUP_COMMAND_MESSAGE_EXTRA_COUNT;
}

function includeInvokingCleanupCommandLimit(limit: number): number {
  return limit + CLEANUP_COMMAND_MESSAGE_EXTRA_COUNT;
}

function includeInvokingCleanupCommandDefault(defaultTarget: number): number {
  return defaultTarget + CLEANUP_COMMAND_MESSAGE_EXTRA_COUNT;
}


function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function requesterDisplayName(message: Message): string {
  return (message.member?.displayName ?? message.author.username).replace(/\s+/g, ' ').trim() || message.author.username;
}

function formatPurgeCleanupResult(message: Message, deleted: number): string {
  return `${requesterDisplayName(message)}님의 요청으로 메시지 ${deleted}개를 삭제했어요...`;
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

  const channelToken = rawChannel.trim().replace(/^<#/, '').replace(/>$/, '');
  const channelId = channelToken.replace(/^#/, '');
  const channelCache = message.guild?.channels.cache;
  const channel = channelCache?.get?.(channelId);
  if (channel?.type === ChannelType.GuildText) return channel;

  const namedChannel = Array.from(channelCache?.values?.() ?? []).find(
    (candidate) => candidate.type === ChannelType.GuildText && candidate.name === channelId
  );
  if (namedChannel?.type === ChannelType.GuildText) return namedChannel;

  const normalizedQuery = normalizeChannelReference(channelToken);
  const candidates = Array.from(message.guild?.channels.cache.values() ?? [])
    .filter((candidate) => candidate.type === ChannelType.GuildText)
    .filter((candidate) => {
      const normalizedCandidate = normalizeChannelReference(candidate.name);
      return normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate);
    });
  if (candidates.length === 1) {
    const [onlyMatch] = candidates;
    if (onlyMatch?.type === ChannelType.GuildText) return onlyMatch;
  }

  if (candidates.length > 1) {
    const suggestions = candidates
      .slice(0, 5)
      .map((candidate) => `<#${candidate.id}>`)
      .join(', ');
    throw new Error(`어느 텍스트 채널인지 하나로 못 좁혔어요... ${suggestions} 중에서 하나로 다시 말해 주세요...`);
  }

  throw new Error('설정할 텍스트 채널을 찾을 수 없어요... `!tts채널 #채널`처럼 입력해 주세요...');
}

function normalizeChannelReference(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^<#/, '')
    .replace(/^#/, '')
    .replace(/(?:채널|방|창)$/g, '')
    .replace(/[^0-9a-z가-힣]/gi, '');
  if (normalized === 'memo') return '메모';
  if (normalized === 'bot-test' || normalized === 'bottest') return '봇테스트';
  return normalized;
}

function pendingChannelHistoryKey(message: Message): string {
  return `${message.guildId ?? 'dm'}:${message.channelId}:${message.author.id}`;
}

function getPendingChannelHistoryRequest(message: Message): PendingChannelHistoryRequest | undefined {
  const key = pendingChannelHistoryKey(message);
  const pending = pendingChannelHistoryRequests.get(key);
  if (!pending) return undefined;
  if (Date.now() - pending.createdAt > PENDING_CHANNEL_HISTORY_TTL_MS) {
    pendingChannelHistoryRequests.delete(key);
    return undefined;
  }
  return pending;
}

function setPendingChannelHistoryRequest(message: Message, pending: Omit<PendingChannelHistoryRequest, 'createdAt'>): void {
  pendingChannelHistoryRequests.set(pendingChannelHistoryKey(message), { ...pending, createdAt: Date.now() });
}

function clearPendingChannelHistoryRequest(message: Message): void {
  pendingChannelHistoryRequests.delete(pendingChannelHistoryKey(message));
}

function channelHistoryModeFromPrompt(prompt: string): 'summary' | 'qa' | null {
  const normalized = prompt.toLowerCase();
  if (/요약|정리|summar|찾아|검색|있는지|있었는지|언급|나왔|내용이 있/i.test(normalized)) return 'summary';
  if (/질문|물어|뭐|무엇|무슨|왜|어떻게|\?|qa|q&a/i.test(normalized)) return 'qa';
  return null;
}

function looksLikeChannelHistoryPrompt(prompt: string): boolean {
  return Boolean(channelHistoryModeFromPrompt(prompt)) && /서버|채널|<#\d+>|#[^\s]+|내용|기록|대화|메모|최근|찾아|검색|언급|있는지|있었는지|나왔/.test(prompt);
}

function hasExplicitChannelReference(prompt: string): boolean {
  return /채널|<#\d+>|#[^\s]+|메모|로그|봇테스트|테스트창/.test(prompt);
}

function isServerWideHistoryTarget(target: string): boolean {
  const normalized = normalizeChannelReference(target);
  return /^(서버전체|전체서버|이서버|현재서버|server|guild|allchannels|all)$/.test(normalized);
}

function isBotBehaviorComplaint(prompt: string): boolean {
  return /왜|아니|뭐야|답답|못알아|말귀|최근.*만|자꾸|또/.test(prompt) && /봇|너|검색|찾|요약|최근|채널|대화/.test(prompt);
}

function findTextChannelFromNaturalReference(message: Message, prompt: string): GuildTextBasedChannel | 'ambiguous' | null {
  const channels = Array.from(message.guild?.channels.cache.values() ?? []).filter(
    (candidate): candidate is GuildTextBasedChannel => candidate.type === ChannelType.GuildText
  );
  const normalizedPrompt = normalizeChannelReference(prompt);
  const matches = channels.filter((candidate) => {
    const normalizedName = normalizeChannelReference(candidate.name);
    if (normalizedName.length < 2) return false;
    return normalizedPrompt.includes(normalizedName) || normalizedName.includes(normalizedPrompt);
  });

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return 'ambiguous';
  return null;
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
    case 'speak':
    case 'talk':
    case 'read':
    case 'tts':
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
    case '프리픽스':
    case 'prefix':
    case 'command-prefix':
    case 'prefixes':
      return `prefix=${args[0] ?? 'show'}`;
    case '기억삭제':
    case 'ai-memory':
    case 'ai-reset-memory':
    case 'memory-reset':
    case 'memory-clear':
    case '메모리삭제':
    case '기억초기화':
      return 'action=reset-memory';
    case '멈춰':
    case 'stop':
    case 'halt':
    case 'cancel':
    case 'pause':
    case '정지':
    case '그만':
    case '멈춤':
    case '스톱':
      return 'action=stop';
    default:
      return `args=${args.join('|').slice(0, 200)}`;
  }
}

export function createPrefixCommands(): Collection<string, PrefixCommand> {
  const commands = new Collection<string, PrefixCommand>();

  const definitions: PrefixCommand[] = [
    {
      name: '청소',
      aliases: ['clean', 'clean-mine', 'clear', '내청소'],
      description: '내가 쓴 최근 메시지를 삭제합니다.',
      async execute(message, args, context) {
        const channel = requireGuildTextChannel(message);
        const amount = parseOptionalPositiveInt(args[0]);
        const result = await cleanupUserMessages(channel as CleanupFetchableChannel, message.author.id, {
          target: includeInvokingCleanupCommandTarget(amount),
          defaultTarget: includeInvokingCleanupCommandDefault(context.settings.cleanMineDefaultTarget),
          maxTarget: includeInvokingCleanupCommandLimit(context.settings.cleanMineMaxLimit)
        });
        if (message.guildId) {
          await context.activityLog.logCleanupResult({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: requesterDisplayName(message),
            commandName: '청소',
            scope: 'own',
            requested: result.requested,
            deleted: result.deleted,
            matched: result.matched,
            skippedOld: result.skippedOld,
            exhausted: result.exhausted
          });
        }
        if (result.deleted === 0) {
          await message.reply({ content: '삭제할 메시지를 찾지 못했어요...', allowedMentions: { repliedUser: false } });
        }
      }
    },
    {
      name: '대청소',
      aliases: ['clean-all', 'purge', 'bulk-clear'],
      description: '관리자용: 최근 채팅을 삭제합니다.',
      async execute(message, args, context) {
        const channel = requireGuildTextChannel(message);
        if (!hasManageMessages(message.member?.permissions)) {
          throw new Error('이 작업은 관리자 권한이 필요해요...');
        }
        const amount = parseOptionalPositiveInt(args[0]);
        const result = await cleanupChannelMessages(channel as CleanupFetchableChannel, {
          target: includeInvokingCleanupCommandTarget(amount),
          defaultTarget: includeInvokingCleanupCommandDefault(context.settings.cleanAllDefaultTarget),
          maxTarget: includeInvokingCleanupCommandLimit(context.settings.cleanAllMaxLimit)
        });
        if (message.guildId) {
          await context.activityLog.logCleanupResult({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: requesterDisplayName(message),
            commandName: '대청소',
            scope: 'purge',
            requested: result.requested,
            deleted: result.deleted,
            matched: result.matched,
            skippedOld: result.skippedOld,
            exhausted: result.exhausted
          });
        }
        if (result.deleted === 0) {
          await message.reply({ content: '삭제할 메시지를 찾지 못했어요...', allowedMentions: { repliedUser: false } });
        } else {
          await channel.send({
            content: formatPurgeCleanupResult(message, result.deleted),
            allowedMentions: { parse: [], repliedUser: false }
          });
        }
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
      aliases: ['말해', 'say', 'tts-say', 'speak', 'talk', 'read', 'tts'],
      description: '지정한 문장을 음성 채널에서 읽습니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const text = args.join(' ').trim();
        if (!text) throw new Error('읽을 문장을 입력해 주세요...');
        if (text.length > MAX_TTS_COMMAND_CHARS) {
          throw new Error(`한 번에 ${MAX_TTS_COMMAND_CHARS}자까지만 읽을 수 있어요...`);
        }
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
        if (!played) {
          const voiceError = context.voice.getLastError(message.guildId);
          await context.activityLog.logError({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: message.author.username,
            commandName: '말',
            summary: `text=${text.slice(0, 500)}`,
            error: new Error(voiceError ? `TTS synthesis/playback failed: ${voiceError}` : 'TTS synthesis/playback failed')
          });
        }
      }
    },
    {
      name: '음색',
      aliases: ['voice', 'tts-voice', '목소리', 'voice-style', 'voicepreset'],
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
      aliases: ['tts-engine', 'engine', '엔진', 'ttsengine'],
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
      name: '시간대',
      aliases: ['timezone', 'tz', '타임존', '시간설정'],
      description: '내 시간대를 확인하거나 설정합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const raw = args[0]?.trim();
        const current = context.voiceSettings.getUserTimeZone(message.guildId, message.author.id);
        if (!raw || ['현재', 'status', 'show', 'info', '조회'].includes(raw.toLowerCase())) {
          await message.reply({
            content: current
              ? `내 시간대는 ${current}예요...`
              : `내 시간대가 아직 없어요... 지금 시간 질문은 ${context.settings.botTimeZone} 기준으로 답해요...`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        const normalized = raw.toLowerCase();
        if (['해제', '기본', 'default', 'reset', 'clear', 'none', '초기화'].includes(normalized)) {
          context.voiceSettings.setUserTimeZone(message.guildId, message.author.id, undefined);
          await message.reply({ content: `시간대 설정을 지웠어요... 이제 ${context.settings.botTimeZone} 기준으로 답해요...`, allowedMentions: { repliedUser: false } });
          return;
        }

        if (!isValidTimeZone(raw)) {
          throw new Error('알 수 없는 시간대예요... 예: Asia/Seoul, America/Los_Angeles, America/New_York');
        }
        context.voiceSettings.setUserTimeZone(message.guildId, message.author.id, raw);
        await message.reply({ content: `내 시간대를 ${raw}로 저장했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '프리픽스',
      aliases: ['prefix', 'command-prefix', 'prefixes'],
      description: '서버 명령어 프리픽스를 확인하거나 변경합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const current = getGuildPrefix(context, message.guildId);
        const raw = args[0]?.trim();
        if (!raw || ['현재', 'status', 'show', 'info', '조회'].includes(raw.toLowerCase())) {
          await message.reply({
            content: [
              `현재 프리픽스는 \`${current}\`예요...`,
              `사용 가능: ${ALLOWED_PREFIXES.map((prefix) => `\`${prefix}\``).join(', ')}`,
              `예시: \`${current}도움말\`, \`${current}청소 3\`, \`${current}말 안녕\``,
              '서버 관리자만 변경할 수 있어요...'
            ].join('\n'),
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        if (!message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
          throw new Error('서버 관리자만 프리픽스를 바꿀 수 있어요...');
        }

        const normalized = raw.toLowerCase();
        if (['해제', '기본', 'default', 'reset', 'clear', 'none', '초기화'].includes(normalized)) {
          context.voiceSettings.setCommandPrefix(message.guildId, undefined);
          await message.reply({ content: '프리픽스를 기본값으로 되돌렸어요... 이제 `!`를 사용해요...', allowedMentions: { repliedUser: false } });
          return;
        }

        if (!isAllowedPrefix(raw)) {
          throw new Error(`허용되는 프리픽스는 ${ALLOWED_PREFIXES.map((prefix) => `\`${prefix}\``).join(', ')}예요...`);
        }

        context.voiceSettings.setCommandPrefix(message.guildId, raw);
        await message.reply({ content: `프리픽스를 \`${raw}\`로 저장했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '멈춰',
      aliases: ['stop', 'halt', 'cancel', 'pause', '정지', '그만', '멈춤', '스톱'],
      description: '현재 TTS 재생을 멈춥니다.',
      async execute(message, _args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        if (!context.voice.isConnected(message.guildId)) {
          throw new Error('봇이 음성 채널에 연결되어 있지 않아요... `!들어와`를 먼저 실행해 주세요...');
        }
        context.voice.stopPlayback(message.guildId);
        await message.reply({ content: '재생을 멈췄어요...', allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '기억삭제',
      aliases: ['ai-memory', 'ai-reset-memory', 'memory-reset', 'memory-clear', '메모리삭제', '기억초기화'],
      description: '서버 AI 기억을 초기화합니다.',
      async execute(message, _args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        if (!message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
          throw new Error('서버 관리자만 AI 기억을 지울 수 있어요...');
        }
        await context.aiChat.resetGuildMemory(message.guildId);
        await message.reply({ content: '서버 AI 기억을 지웠어요...', allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '로그채널삭제',
      aliases: ['로그정리', '로그삭제', 'clear-log-channels', 'delete-log-channels', 'log-clear'],
      description: '로그 서버에서 봇 로그 채널을 삭제합니다.',
      async execute(message, _args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        if (message.guildId !== context.settings.loggingGuildId) {
          throw new Error('로그 서버에서만 사용할 수 있어요...');
        }
        if (!message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
          throw new Error('서버 관리자만 로그 채널을 삭제할 수 있어요...');
        }
        const result = await context.activityLog.deleteManagedLogChannels();
        await message.reply({
          content: result.failed > 0
            ? `로그 채널 ${result.deleted}개를 삭제했고 ${result.failed}개는 실패했어요...`
            : `로그 채널 ${result.deleted}개를 삭제했어요...`,
          allowedMentions: { repliedUser: false }
        });
      }
    },
    {
      name: '도움말',
      aliases: ['help', 'commands', '명령어', 'command', 'cmd'],
      description: '사용 가능한 명령어를 보여줍니다.',
      async execute(message, _args, context) {
        const prefix = getGuildPrefix(context, message.guildId ?? undefined);
        await message.reply({
          content: [
            [`현재 프리픽스는 \`${prefix}\`예요...`, `명령은 프리픽스 뒤에 붙여서 써요...`, `예: \`${prefix}도움말\``].join('\n'),
            `${prefix}도움말 / ${prefix}명령어 / ${prefix}help — 사용 가능한 명령어 목록을 보여줘요...`,
            `${prefix}청소 [개수] / ${prefix}clean [count] / ${prefix}clear [count] — 명령어 글까지 포함해서 내 최근 메시지를 삭제해요...`,
            `${prefix}대청소 [개수] / ${prefix}purge [count] / ${prefix}clean-all [count] / ${prefix}bulk-clear [count] — 관리자용 채널 메시지 삭제... 명령어 글까지 포함해요...`,
            `${prefix}들어와 / ${prefix}이리와 / ${prefix}join / ${prefix}come / ${prefix}여기와 / ${prefix}tts-join — 음성 채널 연결...`,
            `${prefix}나가 / ${prefix}꺼져 / ${prefix}저리가 / ${prefix}leave / ${prefix}go / ${prefix}out / ${prefix}퇴장 / ${prefix}tts-leave — 음성 채널 해제...`,
            `${prefix}tts채널 [#채널|해제] / ${prefix}tts-channel / ${prefix}tts-watch / ${prefix}watch / ${prefix}채널tts — 채널 TTS 읽기 설정/해제...`,
            `${prefix}말 <문장> / ${prefix}say <text> / ${prefix}speak <text> / ${prefix}talk <text> / ${prefix}read <text> / ${prefix}tts <text> — 문장을 음성으로 읽기...`,
            `${prefix}멈춰 / ${prefix}stop / ${prefix}halt / ${prefix}cancel / ${prefix}pause / ${prefix}정지 / ${prefix}그만 / ${prefix}멈춤 / ${prefix}스톱 — TTS 재생 멈추기...`,
            `${prefix}음색 [프리셋] / ${prefix}voice [preset] / ${prefix}voice-style [preset] / ${prefix}voicepreset [preset] / ${prefix}tts-voice [preset] / ${prefix}목소리 [프리셋] — 내 TTS 음색 확인/설정...`,
            `${prefix}tts엔진 [edge|gtts] / ${prefix}engine [edge|gtts] / ${prefix}tts-engine [edge|gtts] / ${prefix}ttsengine [edge|gtts] / ${prefix}엔진 [edge|gtts] — 내 TTS 엔진 확인/설정...`,
            `${prefix}시간대 [Asia/Seoul|America/Los_Angeles|해제] / ${prefix}timezone [time zone] / ${prefix}tz [time zone] — AI 시간 답변 기준 설정...`,
            `현재 프리픽스 뒤에 ?를 붙이고 공백을 넣어 AI 채팅해요... 예: \`${prefix}? 안녕\``,
            `${prefix}기억삭제 / ${prefix}ai-memory / ${prefix}ai-reset-memory / ${prefix}memory-reset / ${prefix}memory-clear / ${prefix}메모리삭제 / ${prefix}기억초기화 — 서버 AI 기억 초기화... (서버 관리자만 가능해요...)`,
            `${prefix}프리픽스 / ${prefix}prefix / ${prefix}command-prefix — 서버 프리픽스 확인/변경... (서버 관리자만 가능해요...)`
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
  const prefix = getGuildPrefix(context, message.guildId);
  const parsed = parsePrefixCommand(message.content, prefix);
  if (!parsed) return false;
  return dispatchResolvedCommand(message, commands, context, parsed, prefix);
}

async function dispatchCommandQuery(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  query: string
): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guildId) return false;
  const normalizedQuery = query.trim().replace(/^[!?.~]\s*/, '');
  const parsed = parsePrefixCommand(`${DEFAULT_PREFIX}${normalizedQuery}`, DEFAULT_PREFIX);
  if (!parsed) return false;
  return dispatchResolvedCommand(message, commands, context, parsed, DEFAULT_PREFIX);
}

async function dispatchResolvedCommand(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  parsed: ParsedPrefixCommand,
  prefix: string
): Promise<boolean> {
  const guildId = message.guildId;
  if (!guildId) return false;
  const command = commands.get(parsed.name);
  if (!command) {
    if (parsed.name === '?') return false;
    await message.reply({ content: `${prefix}도움말로 사용 가능한 명령어를 확인해 주세요...`, allowedMentions: { repliedUser: false } });
    return true;
  }
  const commandSummary = summarizeCommandForLog(command.name, parsed.args);
  await context.activityLog.logCommand({
    guildId,
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
      guildId,
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

const DISCORD_SAFE_CHUNK_LIMIT = 1900;

type HistorySearchResult = {
  history: Awaited<ReturnType<typeof fetchChannelHistory>>;
  source: 'discord-search' | 'recent-fetch' | 'disabled';
  error?: string;
};

function chunkDiscordMessage(content: string, limit = DISCORD_SAFE_CHUNK_LIMIT): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let sliceIndex = remaining.lastIndexOf('\n', limit);
    if (sliceIndex < Math.floor(limit * 0.5)) sliceIndex = limit;
    chunks.push(remaining.slice(0, sliceIndex).trim());
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean).map((chunk) => (chunk.length > 2000 ? chunk.slice(0, limit) : chunk));
}

async function replyWithChunks(message: Message, content: string): Promise<void> {
  const chunks = chunkDiscordMessage(content);
  if (!chunks.length) {
    await message.reply({ content: '응답이 비어 있어요...', allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser: false } });
  const channel = message.channel as GuildTextBasedChannel;
  for (const chunk of chunks.slice(1)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
  }
}

function formatDiscordDisplayTime(timestamp: number): string {
  return `<t:${Math.floor(timestamp / 1000)}:t>`;
}

function channelDisplayName(message: Message, channelId: string): string {
  const channel = message.guild?.channels.cache.get(channelId);
  return channel?.name ? `#${channel.name}` : `#${channelId}`;
}

function buildChannelHistoryLines(
  message: Message,
  history: Awaited<ReturnType<typeof fetchChannelHistory>>
): string {
  return history
    .map((entry) => [
      `시간: ${formatDiscordDisplayTime(entry.createdTimestamp)}`,
      `채널: ${channelDisplayName(message, entry.channelId)}`,
      `작성자: ${entry.authorName}`,
      `내용: ${entry.content}`
    ].join('\n'))
    .join('\n\n');
}

function buildChannelHistoryMessages(
  message: Message,
  history: Awaited<ReturnType<typeof fetchChannelHistory>>,
  mode: 'summary' | 'qa',
  query: string,
  topic: string | null = null
): AiChatMessage[] {
  const channelNames = Array.from(new Set(history.map((entry) => channelDisplayName(message, entry.channelId)))).join(', ');
  const messages: AiChatMessage[] = [
    {
      role: 'system',
      content: [
        '당신은 Discord 서버 대화 기록을 요약하는 도우미예요.',
        '사용자가 특정 주제/단어가 있는지 물었다면 전체 요약을 하지 말고 그 주제가 있는지, 있다면 관련 메시지만 알려줘요.',
        '비슷한 것/관련된 것을 찾는 요청이면 단어가 정확히 같지 않아도 음식 종류, 상위 범주, 의미가 가까운 표현을 판단해요.',
        '관련 메시지가 없으면 다른 최근 대화 목록을 늘어놓지 말고 찾지 못했다고만 말해요.',
        '출력에는 "(한국어)" 같은 언어 라벨을 붙이지 않아요.',
        '채널은 ID나 멘션 대신 제공된 #채널이름 그대로 써요.',
        '시간은 제공된 Discord timestamp를 그대로 써요. UTC, ISO, 한국시간 같은 고정 시간대로 바꾸지 않아요.',
        '답변은 중간에 끊기지 않게 6줄 이내로 짧게 써요.',
        '불필요한 제목이나 장식 없이 핵심만 말해요.'
      ].join('\n')
    },
    { role: 'system', content: `읽은 채널: ${channelNames || '알 수 없음'}` },
    topic ? { role: 'system' as const, content: `검색 주제: ${topic}` } : undefined,
    { role: 'user', content: `대화 기록:\n${buildChannelHistoryLines(message, history)}` }
  ].filter((item): item is AiChatMessage => Boolean(item));
  messages.push({
    role: 'user',
    content:
      mode === 'summary'
        ? `최근 대화를 짧게 요약해 주세요...\n${query}`
        : `다음 대화 기록을 바탕으로 질문에 답해 주세요...\n${query}`
  });
  return messages;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s"'“”'‘’.,!?！？…~\-_/\\()[\]{}:;]+/g, '');
}

function filterHistoryByQuery(
  history: Awaited<ReturnType<typeof fetchChannelHistory>>,
  query: string
): Awaited<ReturnType<typeof fetchChannelHistory>> {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return history;
  return history.filter((entry) => normalizeSearchText(entry.content).includes(normalizedQuery));
}

function isSummaryOnlyHistoryQuery(query: string): boolean {
  return /요약|정리|최근.*(?:대화|내용)|무슨\s*대화|뭐.*말했|내용\s*요약/i.test(query)
    && !/찾|검색|있나|있는지|있었는지|나왔|언급|비슷|관련|대한|관한/i.test(query);
}

function isFuzzyTopicLookupQuery(query: string): boolean {
  return /비슷|관련|그런\s*거|뭐\s*그런|같은\s*거/i.test(query);
}

function isLoggingGuild(message: Message, context: BotContext): boolean {
  return Boolean(message.guildId && message.guildId === context.settings.loggingGuildId);
}

function canAccessLoggingHistory(message: Message): boolean {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function isManagedLogTextChannel(channel: { type: ChannelType; name?: string; topic?: string | null }): boolean {
  return channel.type === ChannelType.GuildText && (channel.name?.startsWith('LOG-') || Boolean(channel.topic?.startsWith('Source guild: ')));
}

function searchableHistoryChannels(message: Message, context: BotContext): GuildTextBasedChannel[] {
  return Array.from(message.guild?.channels.cache.values() ?? [])
    .filter((candidate): candidate is GuildTextBasedChannel => candidate.type === ChannelType.GuildText && 'messages' in candidate)
    .filter((candidate) => !isLoggingGuild(message, context) || !isManagedLogTextChannel(candidate));
}

async function fetchRecentGuildTextHistory(
  message: Message,
  context: BotContext,
  options: { limit: number; lookbackHours: number }
): Promise<Awaited<ReturnType<typeof fetchChannelHistory>>> {
  const channels = searchableHistoryChannels(message, context)
    .slice(0, MAX_AUTO_HISTORY_CHANNELS);
  const perChannelLimit = Math.max(1, Math.min(options.limit, Math.ceil(options.limit / Math.max(1, Math.min(channels.length, 5)))));
  const settled = await Promise.allSettled(
    channels.map((channel) =>
      fetchChannelHistory(channel, {
        limit: perChannelLimit,
        lookbackHours: options.lookbackHours
      })
    )
  );

  const combined = settled
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .filter((entry) => entry.id !== message.id);
  return combined
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
    .slice(0, options.limit)
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp);
}

async function searchIndexedGuildTextHistory(
  message: Message,
  context: BotContext,
  query: string,
  options: { limit: number; channelIds?: string[] }
): Promise<HistorySearchResult> {
  const botToken = context.settings.discordToken;
  if (!message.guildId || typeof botToken !== 'string' || !botToken.trim()) {
    return { history: [], source: 'disabled' };
  }
  try {
    const history = (await searchGuildMessages({
      guildId: message.guildId,
      botToken,
      query,
      channelIds: options.channelIds,
      limit: options.limit
    })).filter((entry) => entry.id !== message.id);
    return { history, source: 'discord-search' };
  } catch (error) {
    logger.warn('Discord indexed message search failed; falling back to recent fetch:', error);
    const details = extractErrorDetails(error);
    return { history: [], source: 'recent-fetch', error: details.errorMessage ?? String(error) };
  }
}


async function createAndReplyConfirmation(
  message: Message,
  confirmations: ConfirmationManager,
  intent: ConfirmationScope['intent'],
  preview: string,
  normalizedArgs: string
): Promise<void> {
  if (!message.guildId) return;
  const scope: ConfirmationScope = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    intent,
    targetChannelId: extractLeadingChannelReference(normalizedArgs),
    normalizedArgs
  };
  const confirmation = confirmations.create(scope, preview);
  await message.reply({
    content: [preview, `확인 토큰: \`${confirmation.token}\``, '확인을 처리하는 흐름은 다음 작업에서 이어갈 수 있어요...'].join('\n'),
    allowedMentions: { repliedUser: false }
  });
}

function confirmationPreviewForSafety(safety: CommandSafety): string {
  switch (safety.intent) {
    case 'cleanup':
      return safety.level === 'destructive' ? '채널 메시지 삭제를 진행할까요?' : '내 메시지 삭제를 진행할까요?';
    case 'prefix-change':
      return '서버 프리픽스를 바꿀까요?';
    case 'memory-reset':
      return '서버 AI 기억을 지울까요?';
    case 'watch-channel':
      return 'TTS 채널 설정을 바꿀까요?';
    default:
      return '이 명령을 실행할까요?';
  }
}

async function logPlannerDiagnostic(
  message: Message,
  context: BotContext,
  details: {
    event: 'request' | 'response' | 'parse_error' | 'retry' | 'decision' | 'error' | 'rate_limit';
    retryCount?: number;
    decisionKind?: string;
    validationErrors?: string[];
    promptSnippet?: string;
    responseSnippet?: string;
    model?: string;
    usageScope?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    rateLimitHeaders?: Readonly<Record<string, string>>;
    status?: number;
    error?: unknown;
    commandSafety?: string;
  }
): Promise<void> {
  if (!message.guildId) return;
  const errorDetails = details.error ? extractErrorDetails(details.error) : undefined;
  if (typeof context.activityLog.logAiDiagnostic !== 'function') return;
  await context.activityLog.logAiDiagnostic({
    guildId: message.guildId,
    guildName: message.guild?.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.username,
    stage: 'planner',
    event: details.event,
    model: details.model,
    usageScope: details.usageScope ?? 'planner',
    decisionKind: details.decisionKind,
    commandSafety: details.commandSafety,
    retryCount: details.retryCount,
    validationErrors: details.validationErrors,
    promptSnippet: details.promptSnippet,
    responseSnippet: details.responseSnippet,
    promptTokens: details.promptTokens,
    completionTokens: details.completionTokens,
    totalTokens: details.totalTokens,
    rateLimitHeaders: details.rateLimitHeaders ?? errorDetails?.rateLimitHeaders,
    status: details.status ?? errorDetails?.status,
    errorName: errorDetails?.errorName,
    errorMessage: errorDetails?.errorMessage
  }).catch((error) => logger.warn('Failed to log planner diagnostic:', error));
}

function isRateLimitLike(error: unknown): boolean {
  return extractErrorDetails(error).status === 429;
}

async function dispatchPlannerCommand(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager,
  query: string
): Promise<boolean> {
  const safety = classifyCommandQuery(query, commands);
  await logPlannerDiagnostic(message, context, {
    event: 'decision',
    decisionKind: 'command',
    commandSafety: `${safety.level}:${safety.reason}`
  });

  if (safety.level === 'unknown') {
    await message.reply({ content: '어떤 명령을 실행해야 할지 확실하지 않아요... 조금 더 구체적으로 말해 주세요...', allowedMentions: { repliedUser: false } });
    return true;
  }

  if (safety.level === 'needs-confirmation' || safety.level === 'destructive') {
    if (!safety.intent) {
      await message.reply({ content: '이 명령은 확인이 필요해요... 어떤 작업인지 다시 말해 주세요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    if (safety.intent === 'cleanup' && safety.level === 'destructive' && !hasManageMessages(message.member?.permissions)) {
      await message.reply({ content: '이 작업은 관리자 권한이 필요해요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    await createAndReplyConfirmation(message, confirmations, safety.intent, confirmationPreviewForSafety(safety), safety.args.join(' ').trim());
    return true;
  }

  if (safety.level === 'voice-precondition') {
    const member = message.member as GuildMember | null;
    if (!member?.voice?.channel) {
      await message.reply({ content: buildUnavailableVoiceMessage(), allowedMentions: { repliedUser: false } });
      return true;
    }
  }

  return dispatchCommandQuery(message, commands, context, query);
}

async function handleChannelHistoryPlan(
  message: Message,
  route: Extract<RoutedNaturalLanguageCommand, { kind: 'channel-history' }>,
  context: BotContext
): Promise<boolean> {
  if (!message.guildId) return false;
  try {
    const targetChannel = resolveTargetGuildTextChannel(message, route.targetChannelReference);
    if (isLoggingGuild(message, context) && isManagedLogTextChannel(targetChannel) && !canAccessLoggingHistory(message)) {
      await message.reply({ content: '로그 채널 내용은 관리자만 확인할 수 있어요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    const assessment = assessChannelHistoryQuery(route.query);
    if (assessment.status !== 'ready') {
      await message.reply({ content: assessment.prompt, allowedMentions: { repliedUser: false } });
      return true;
    }

    const queryTopic = route.query.trim() || null;
    const isTopicLookup = Boolean(queryTopic && !isSummaryOnlyHistoryQuery(route.query));
    const searchLimit = queryTopic && assessment.limit === DEFAULT_HISTORY_MESSAGE_LIMIT ? MAX_HISTORY_MESSAGE_LIMIT : assessment.limit;
    const searchLookbackHours = queryTopic && assessment.lookbackHours === DEFAULT_HISTORY_LOOKBACK_HOURS ? MAX_HISTORY_LOOKBACK_HOURS : assessment.lookbackHours;
    const indexedSearch = queryTopic
      ? await searchIndexedGuildTextHistory(message, context, route.query, { limit: searchLimit, channelIds: [targetChannel.id] })
      : { history: [], source: 'disabled' as const };
    const history = indexedSearch.history.length ? indexedSearch.history : (await fetchChannelHistory(targetChannel, {
      limit: searchLimit,
      lookbackHours: searchLookbackHours
    })).filter((entry) => entry.id !== message.id);
    const filteredHistory = isTopicLookup ? filterHistoryByQuery(history, route.query) : history;
    const usedHistory = isTopicLookup
      ? (filteredHistory.length || !isFuzzyTopicLookupQuery(route.query) ? filteredHistory : history)
      : history;
    await context.activityLog.logChannelHistory({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      mode: route.mode,
      query: route.query,
      topic: queryTopic,
      targetChannelId: targetChannel.id,
      searchSource: indexedSearch.history.length ? indexedSearch.source : 'recent-fetch',
      searchError: indexedSearch.error,
      scannedChannels: 1,
      matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
      usedMessages: usedHistory.length
    }).catch((logError) => logger.warn('Failed to log channel-history result:', logError));

    if (isTopicLookup && !usedHistory.length) {
      setPendingChannelHistoryRequest(message, { mode: route.mode, query: route.query });
      await message.reply({
        content: `${route.query}에 관한 내용은 <#${targetChannel.id}>에서 찾지 못했어요...`,
        allowedMentions: { repliedUser: false }
      });
      return true;
    }

    if (!history.length) {
      setPendingChannelHistoryRequest(message, { mode: route.mode, query: route.query });
      await message.reply({
        content: `<#${targetChannel.id}>에서 ${searchLimit}개 또는 ${Math.round(searchLookbackHours / 24)}일 범위 안에 읽을 메시지를 찾지 못했어요... 다른 채널을 말하면 같은 내용으로 다시 찾아볼게요...`,
        allowedMentions: { repliedUser: false }
      });
      return true;
    }

    clearPendingChannelHistoryRequest(message);
    const answer = await context.ai.askMessages({
      guildId: message.guildId,
      userId: message.author.id,
      usageScope: 'summary',
      messages: buildChannelHistoryMessages(message, usedHistory, route.mode, route.query, queryTopic)
    });
    await replyWithChunks(message, answer);
  } catch (error) {
    logger.error(error);
    await context.activityLog.logAiDiagnostic({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      stage: 'summary',
      event: isRateLimitLike(error) ? 'rate_limit' : 'error',
      usageScope: 'summary',
      ...extractErrorDetails(error)
    }).catch((logError) => logger.warn('Failed to log channel-history diagnostic:', logError));
    const details = extractErrorDetails(error);
    const content = details.status === 429
      ? 'AI 요청이 잠시 많아요. 조금 뒤에 다시 시도해 주세요...'
      : details.errorMessage || '채널 기록을 확인하지 못했어요... 다시 시도해 주세요...';
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  }
  return true;
}

async function handleGuildChannelHistoryPlan(
  message: Message,
  mode: 'summary' | 'qa',
  query: string,
  context: BotContext
): Promise<boolean> {
  if (!message.guildId) return false;
  try {
    if (isLoggingGuild(message, context) && !canAccessLoggingHistory(message)) {
      await message.reply({ content: '로그 서버의 전체 대화 검색은 관리자만 사용할 수 있어요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    const assessment = assessChannelHistoryQuery(query);
    if (assessment.status !== 'ready') {
      await message.reply({ content: assessment.prompt, allowedMentions: { repliedUser: false } });
      return true;
    }

    const queryTopic = query.trim() || null;
    const isTopicLookup = Boolean(queryTopic && !isSummaryOnlyHistoryQuery(query));
    const searchLimit = queryTopic && assessment.limit === DEFAULT_HISTORY_MESSAGE_LIMIT ? MAX_HISTORY_MESSAGE_LIMIT : assessment.limit;
    const searchLookbackHours = queryTopic && assessment.lookbackHours === DEFAULT_HISTORY_LOOKBACK_HOURS ? MAX_HISTORY_LOOKBACK_HOURS : assessment.lookbackHours;
    const searchableChannels = searchableHistoryChannels(message, context);
    const searchableChannelIds = isLoggingGuild(message, context) ? searchableChannels.map((channel) => channel.id) : undefined;
    const indexedSearch = queryTopic
      ? await searchIndexedGuildTextHistory(message, context, query, { limit: searchLimit, channelIds: searchableChannelIds })
      : { history: [], source: 'disabled' as const };
    const history = indexedSearch.history.length ? indexedSearch.history : await fetchRecentGuildTextHistory(message, context, {
      limit: searchLimit,
      lookbackHours: searchLookbackHours
    });
    const filteredHistory = isTopicLookup ? filterHistoryByQuery(history, query) : history;
    const usedHistory = isTopicLookup
      ? (filteredHistory.length || !isFuzzyTopicLookupQuery(query) ? filteredHistory : history)
      : history;
    await context.activityLog.logChannelHistory({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      mode,
      query,
      topic: queryTopic,
      searchSource: indexedSearch.history.length ? indexedSearch.source : 'recent-fetch',
      searchError: indexedSearch.error,
      scannedChannels: Math.min(
        MAX_AUTO_HISTORY_CHANNELS,
        searchableChannels.length
      ),
      matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
      usedMessages: usedHistory.length
    }).catch((logError) => logger.warn('Failed to log channel-history result:', logError));

    if (isTopicLookup && !usedHistory.length) {
      setPendingChannelHistoryRequest(message, { mode, query });
      await message.reply({
        content: `${query}에 관한 내용은 서버에서 찾지 못했어요...`,
        allowedMentions: { repliedUser: false }
      });
      return true;
    }

    if (!history.length) {
      setPendingChannelHistoryRequest(message, { mode, query });
      await message.reply({
        content: `${queryTopic ? '서버에서' : '최근'} ${searchLimit}개 또는 ${Math.round(searchLookbackHours / 24)}일 범위 안에 읽을 대화를 찾지 못했어요... 채널을 말하면 같은 내용으로 다시 찾아볼게요...`,
        allowedMentions: { repliedUser: false }
      });
      return true;
    }
    const answer = await context.ai.askMessages({
      guildId: message.guildId,
      userId: message.author.id,
      usageScope: 'summary',
      messages: buildChannelHistoryMessages(message, usedHistory, mode, query, queryTopic)
    });
    if (queryTopic) setPendingChannelHistoryRequest(message, { mode, query });
    else clearPendingChannelHistoryRequest(message);
    await replyWithChunks(message, answer);
  } catch (error) {
    logger.error(error);
    await context.activityLog.logAiDiagnostic({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      stage: 'summary',
      event: isRateLimitLike(error) ? 'rate_limit' : 'error',
      usageScope: 'summary',
      ...extractErrorDetails(error)
    }).catch((logError) => logger.warn('Failed to log guild channel-history diagnostic:', logError));
    const details = extractErrorDetails(error);
    const content = details.status === 429
      ? 'AI 요청이 잠시 많아요. 조금 뒤에 다시 시도해 주세요...'
      : details.errorMessage || '최근 대화를 확인하지 못했어요... 다시 시도해 주세요...';
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  }
  return true;
}

async function handleNaturalLanguageRoute(
  message: Message,
  route: RoutedNaturalLanguageCommand,
  context: BotContext,
  commands: Collection<string, PrefixCommand>,
  confirmations: ConfirmationManager
): Promise<boolean> {
  if (!message.guildId) return false;

  switch (route.kind) {
    case 'clarify':
      await message.reply({ content: route.message, allowedMentions: { repliedUser: false } });
      return true;
    case 'command':
      return dispatchCommandQuery(message, commands, context, route.query);
    case 'confirmation': {
      const scope: ConfirmationScope = {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        intent: route.intent,
        targetChannelId: extractLeadingChannelReference(route.normalizedArgs),
        normalizedArgs: route.normalizedArgs
      };
      const confirmation = confirmations.create(scope, route.preview);
      await message.reply({
        content: [route.preview, `확인 토큰: \`${confirmation.token}\``, '확인을 처리하는 흐름은 다음 작업에서 이어갈 수 있어요...'].join('\n'),
        allowedMentions: { repliedUser: false }
      });
      return true;
    }
    case 'channel-history':
      return handleChannelHistoryPlan(message, route, context);
  }
}

async function handlePendingChannelHistoryReply(
  message: Message,
  prompt: string,
  context: BotContext
): Promise<boolean> {
  const pending = getPendingChannelHistoryRequest(message);
  if (!pending) return false;

  const targetChannel = findTextChannelFromNaturalReference(message, prompt);
  if (targetChannel && targetChannel !== 'ambiguous') {
    clearPendingChannelHistoryRequest(message);
    return handleChannelHistoryPlan(
      message,
      {
        kind: 'channel-history',
        mode: pending.mode,
        targetChannelReference: `<#${targetChannel.id}>`,
        query: pending.query
      },
      context
    );
  }

  if (targetChannel === 'ambiguous') {
    await message.reply({ content: '비슷한 채널이 여러 개 있어요... 정확한 채널 멘션으로 다시 말해 주세요...', allowedMentions: { repliedUser: false } });
    return true;
  }

  return false;
}

async function handleDirectChannelHistoryPrompt(
  message: Message,
  prompt: string,
  context: BotContext
): Promise<boolean> {
  const mode = channelHistoryModeFromPrompt(prompt);
  if (!mode || !looksLikeChannelHistoryPrompt(prompt) || isBotBehaviorComplaint(prompt)) return false;

  const targetChannel = findTextChannelFromNaturalReference(message, prompt);
  if (targetChannel && targetChannel !== 'ambiguous') {
    clearPendingChannelHistoryRequest(message);
    return handleChannelHistoryPlan(
      message,
      {
        kind: 'channel-history',
        mode,
        targetChannelReference: `<#${targetChannel.id}>`,
        query: prompt
      },
      context
    );
  }

  if (targetChannel === 'ambiguous') {
    setPendingChannelHistoryRequest(message, { mode, query: prompt });
    await message.reply({ content: '비슷한 채널이 여러 개 있어요... 어느 채널을 요약할지 채널 멘션으로 말해 주세요...', allowedMentions: { repliedUser: false } });
    return true;
  }

  if (!hasExplicitChannelReference(prompt)) {
    clearPendingChannelHistoryRequest(message);
    return handleGuildChannelHistoryPlan(message, mode, prompt, context);
  }

  setPendingChannelHistoryRequest(message, { mode, query: prompt });
  await message.reply({ content: '어느 채널을 요약할지 못 찾았어요... 채널 이름이나 멘션을 다시 말해 주세요...', allowedMentions: { repliedUser: false } });
  return true;
}


function formatDiscordLocalTime(timestampMs: number): string {
  return `<t:${Math.floor(timestampMs / 1000)}:t>예요...`;
}

function formatTimeInZone(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(new Date(timestampMs));
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? '';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  return `${dayPeriod} ${hour}시 ${minute}분`.trim();
}

function buildTimePlanReply(message: Message, plan: Extract<import('./services/aiCommandPlanner.js').AiCommandPlan, { kind: 'time' }>): string {
  const timestampMs = message.createdTimestamp + (plan.offsetSeconds ?? 0) * 1_000;
  if (plan.target === 'viewer') return formatDiscordLocalTime(timestampMs);
  const label = plan.label || plan.timeZone || '해당 지역';
  return `${label} 시간은 ${formatTimeInZone(timestampMs, plan.timeZone!)}이에요...`;
}

async function handleTimePlan(message: Message, plan: Extract<import('./services/aiCommandPlanner.js').AiCommandPlan, { kind: 'time' }>, context: BotContext): Promise<boolean> {
  const answer = buildTimePlanReply(message, plan);
  await message.reply({ content: answer, allowedMentions: { parse: [], repliedUser: false } });
  await context.activityLog.logCommand({
    guildId: message.guildId!,
    guildName: message.guild?.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: requesterDisplayName(message),
    commandName: 'ai-time-response',
    summary: `answer=${answer}`
  }).catch((error) => logger.warn('Failed to log AI time response:', error));
  return true;
}

function extractLeadingChannelReference(text: string): string | undefined {
  const [first] = text.trim().split(/\s+/);
  if (!first) return undefined;
  if (first.startsWith('<#') || first.startsWith('#')) return first;
  return undefined;
}

export async function handleMessageCreate(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager
): Promise<boolean> {
  if (!message.guildId) return false;
  if (!message.author.bot) {
    if (await dispatchPrefixCommand(message, commands, context)) return true;
    const prefix = getGuildPrefix(context, message.guildId);
    if (message.content.trim() === `${prefix}?`) {
      await message.reply({ content: `${prefix}? 뒤에 질문이나 요청을 적어 주세요...`, allowedMentions: { repliedUser: false } });
      return true;
    }
    const aiPrompt = parseAiChatTrigger(message.content, prefix);
    if (aiPrompt) {
      const pendingHistoryRequest = getPendingChannelHistoryRequest(message);
      if (context.aiCommandPlanner) {
        try {
          const member = message.member as GuildMember | null;
          const plan = await context.aiCommandPlanner.plan(message, aiPrompt, {
            prefix,
            commands,
            availableChannels: listTextChannelCandidates(message),
            userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
            botVoiceConnected: context.voice.isConnected(message.guildId),
            maxCompletionTokens: context.settings.aiPlannerMaxCompletionTokens,
            pendingHistory: pendingHistoryRequest ? { mode: pendingHistoryRequest.mode, query: pendingHistoryRequest.query } : null,
            onDiagnostic: (details) => logPlannerDiagnostic(message, context, details)
          });
          switch (plan.kind) {
            case 'chat':
              if (await handlePendingChannelHistoryReply(message, aiPrompt, context)) return true;
              if (await handleDirectChannelHistoryPrompt(message, aiPrompt, context)) return true;
              await context.aiChat.handlePrompt(message, aiPrompt);
              return true;
            case 'command':
              return dispatchPlannerCommand(message, commands, context, confirmations, plan.query);
            case 'channel-history':
              if (isServerWideHistoryTarget(plan.targetChannelReference)) {
                return handleGuildChannelHistoryPlan(message, plan.mode, plan.query, context);
              }
              return handleChannelHistoryPlan(
                message,
                {
                  kind: 'channel-history',
                  mode: plan.mode,
                  targetChannelReference: plan.targetChannelReference,
                  query: plan.query
                },
                context
              );
            case 'time':
              return handleTimePlan(message, plan, context);
            case 'clarify':
              if (pendingHistoryRequest && await handlePendingChannelHistoryReply(message, aiPrompt, context)) return true;
              if (looksLikeChannelHistoryPrompt(aiPrompt)) {
                const mode = channelHistoryModeFromPrompt(aiPrompt) ?? 'summary';
                setPendingChannelHistoryRequest(message, { mode, query: aiPrompt });
              }
              await message.reply({ content: plan.message, allowedMentions: { repliedUser: false } });
              return true;
            case 'unavailable':
              await message.reply({ content: plan.message, allowedMentions: { repliedUser: false } });
              return true;
          }
        } catch (error) {
          if (isRateLimitLike(error)) {
            await logPlannerDiagnostic(message, context, { event: 'rate_limit', error });
            await message.reply({ content: 'AI 요청이 잠시 많아요. 조금 뒤에 다시 시도해 주세요...', allowedMentions: { repliedUser: false } });
            return true;
          }
          await logPlannerDiagnostic(message, context, { event: 'error', error });
          await context.aiChat.handlePrompt(message, aiPrompt);
          return true;
        }
      }
      if (await handlePendingChannelHistoryReply(message, aiPrompt, context)) return true;
      const fallbackRoute = routeNaturalLanguageCommand(message.content, prefix);
      if (fallbackRoute && (await handleNaturalLanguageRoute(message, fallbackRoute, context, commands, confirmations))) {
        return true;
      }
      await context.aiChat.handlePrompt(message, aiPrompt);
      return true;
    }
    const routed = routeNaturalLanguageCommand(message.content, prefix);
    if (routed && (await handleNaturalLanguageRoute(message, routed, context, commands, confirmations))) {
      return true;
    }
  }
  if (message.author.bot && !context.settings.ttsReadBotMessages) return false;
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
  return Boolean(queued);
}

function listTextChannelCandidates(message: Message): Array<{ id: string; name: string; mention: string }> {
  const channels = Array.from(message.guild?.channels.cache?.values?.() ?? [])
    .filter((candidate) => candidate.type === ChannelType.GuildText)
    .map((candidate) => ({ id: candidate.id, name: candidate.name, mention: `<#${candidate.id}>` }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ko'));
  return (channels ?? []).slice(0, 40);
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
  const memoryStore = new SqliteAiMemoryStore(settings.databasePath);
  const voiceSettings = new SqliteVoiceSettingsStore(settings.databasePath);
  const activityLog = new BotActivityLogService(client, new SqliteBotActivityLogStore(settings.databasePath), settings.loggingGuildId);
  const ai = new AiService(settings, usageStore);
  const aiCommandPlanner = new AiCommandPlanner(ai);
  const confirmations = new ConfirmationManager();
  const context: BotContext = {
    settings,
    usageStore,
    ai,
    aiChat: new AiChatService(settings, ai, memoryStore, activityLog, voiceSettings),
    aiCommandPlanner,
    activityLog,
    voiceSettings,
    voice: new VoiceService(
      new TtsService(settings.ttsVoice, settings.ttsMaxChars),
      voiceSettings,
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
    await handleMessageCreate(message, commands, context, confirmations);
  });

  return { client, context, commands };
}
