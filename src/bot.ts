import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { AttachmentBuilder, ChannelType, Client, Collection, EmbedBuilder, Events, GatewayIntentBits, GuildMember, PermissionFlagsBits } from 'discord.js';
import type { GuildTextBasedChannel, Message, TextChannel } from 'discord.js';
import type { PrefixCommand } from './types.js';
import type { Settings } from './config.js';
import type { UsageStore } from './services/usageStore.js';
import { AiService } from './services/aiService.js';
import { extractErrorDetails, type AiChatMessage } from './services/aiService.js';
import { AiCommandPlanner } from './services/aiCommandPlanner.js';
import { AgentRuntime, type AgentRuntimeDiagnostic, type AgentRuntimeOutcome } from './services/agentRuntime.js';
import { AgentTurnContextStore } from './services/agentTurnContextStore.js';
import {
  AgentToolExecutionError,
  createDefaultToolRegistry,
  type AgentToolExecutionContext,
  type HistorySearchInput,
  type HistorySearchOutput,
  type TtsEngineInput,
  type TtsEngineOutput,
  type TtsVoicePresetInput,
  type TtsVoicePresetOutput,
  type UserTimezoneInput,
  type UserTimezoneOutput,
  type TarotRevealSelectionInput,
  type TarotRevealSelectionOutput,
  type TarotStartReadingInput,
  type TarotStartReadingOutput,
  type VoiceSpeakInput,
  type VoiceSpeakOutput,
  type VoiceStopOutput
} from './services/toolRegistry.js';
import { createWebSearchProvider, type WebSearchMode, type WebSearchProvider } from './services/webSearchService.js';
import { drawTarotCardsFromNumbers, formatTarotEnergyBars, validateTarotSelectionNumbers } from './services/tarotDeck.js';
import { TarotSessionStore, type TarotSessionKey } from './services/tarotSessionStore.js';
import { AiChatService, parseAiChatTrigger, type AiChatRuntimeContext } from './services/aiChatService.js';
import { BotActivityLogService } from './services/botActivityLogService.js';
import { ConfirmationManager, type ConfirmationScope, type PendingConfirmation } from './services/confirmationManager.js';
import {
  DEFAULT_HISTORY_LOOKBACK_HOURS,
  DEFAULT_HISTORY_MESSAGE_LIMIT,
  MAX_HISTORY_LOOKBACK_HOURS,
  MAX_HISTORY_MESSAGE_LIMIT,
  assessChannelHistoryQuery,
  fetchChannelHistory,
  searchGuildMessages,
  type ChannelHistoryEntry
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
const CONFIRMATION_MESSAGE_ATTEMPTS = 1;

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
  agentRuntime?: AgentRuntime;
  agentTurnContextStore?: AgentTurnContextStore;
  tarotSessions?: TarotSessionStore;
  webSearchProvider?: WebSearchProvider;
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

function getGuildWebSearchMode(context: BotContext, guildId?: string): WebSearchMode {
  if (!guildId) return context.settings.webSearchDefaultMode;
  return context.voiceSettings.getGuildWebSearchMode(guildId) ?? context.settings.webSearchDefaultMode;
}

function isAllowedPrefix(prefix: string): prefix is (typeof ALLOWED_PREFIXES)[number] {
  return (ALLOWED_PREFIXES as readonly string[]).includes(prefix);
}

function parseWebSearchModeArg(raw: string | undefined): WebSearchMode | 'reset' | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return null;
  if (['해제', '기본', 'default', 'reset', 'clear', 'none', '초기화'].includes(normalized)) return 'reset';
  if (['disabled', 'disable', 'off', '꺼짐', '끄기', '비활성'].includes(normalized)) return 'disabled';
  if (['explicit_only', 'explicit-only', 'explicit', 'manual', '명시', '수동', '명시적'].includes(normalized)) return 'explicit_only';
  if (['automatic', 'auto', '자동'].includes(normalized)) return 'automatic';
  if (['search_first_factual', 'search-first-factual', 'factual', 'search-first', '사실우선', '검색우선', '기본모드'].includes(normalized)) return 'search_first_factual';
  return null;
}

function formatWebSearchMode(mode: WebSearchMode): string {
  switch (mode) {
    case 'disabled':
      return 'disabled (웹 검색 꺼짐)';
    case 'explicit_only':
      return 'explicit_only (명시적으로 검색을 요청할 때만)';
    case 'automatic':
      return 'automatic (필요하면 자동 검색)';
    case 'search_first_factual':
      return 'search_first_factual (사실 확인 질문은 검색 우선)';
  }
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

function excludeInvokingCleanupCommandCount(count: number): number {
  return Math.max(0, count - CLEANUP_COMMAND_MESSAGE_EXTRA_COUNT);
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

function clearAgentTurnContext(message: Message, context: BotContext): void {
  if (!message.guildId) return;
  context.agentTurnContextStore?.clear({ guildId: message.guildId, channelId: message.channelId, userId: message.author.id });
}

function isServerWideHistoryTarget(target: string): boolean {
  const normalized = normalizeChannelReference(target);
  return /^(서버전체|전체서버|이서버|현재서버|server|guild|allchannels|all)$/.test(normalized);
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
    case 'ai채널':
    case 'ai-channel':
    case 'ai-chat-channel':
    case 'ai-watch':
    case '채널ai':
      return `action=${args[0] ?? 'set-current'}`;
    case '웹검색':
    case 'web-search':
    case 'search-mode':
    case '검색설정':
      return `mode=${args[0] ?? 'show'}`;
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
        const visibleRequested = excludeInvokingCleanupCommandCount(result.requested);
        const visibleMatched = excludeInvokingCleanupCommandCount(result.matched);
        const visibleDeleted = excludeInvokingCleanupCommandCount(result.deleted);
        if (message.guildId) {
          await context.activityLog.logCleanupResult({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: requesterDisplayName(message),
            commandName: '청소',
            scope: 'own',
            requested: visibleRequested,
            deleted: visibleDeleted,
            matched: visibleMatched,
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
        const visibleRequested = excludeInvokingCleanupCommandCount(result.requested);
        const visibleMatched = excludeInvokingCleanupCommandCount(result.matched);
        const visibleDeleted = excludeInvokingCleanupCommandCount(result.deleted);
        if (message.guildId) {
          await context.activityLog.logCleanupResult({
            guildId: message.guildId,
            guildName: message.guild?.name,
            channelId: message.channelId,
            userId: message.author.id,
            userName: requesterDisplayName(message),
            commandName: '대청소',
            scope: 'purge',
            requested: visibleRequested,
            deleted: visibleDeleted,
            matched: visibleMatched,
            skippedOld: result.skippedOld,
            exhausted: result.exhausted
          });
        }
        if (visibleDeleted === 0) {
          await message.reply({ content: '삭제할 메시지를 찾지 못했어요...', allowedMentions: { repliedUser: false } });
        } else {
          await channel.send({
            content: formatPurgeCleanupResult(message, visibleDeleted),
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
      name: 'ai채널',
      aliases: ['ai-channel', 'ai-chat-channel', 'ai-watch', '채널ai'],
      description: 'AI가 자동으로 답할 텍스트 채널을 설정하거나 해제합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const action = args[0]?.trim();
        if (!action) {
          context.voiceSettings.setAiChannelId(message.guildId, message.channelId);
          await message.reply({
            content: `<#${message.channelId}>를 AI 채팅 채널로 설정했어요...`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        const normalized = action.toLowerCase();
        if (['현재', 'status', 'show', 'info', '조회'].includes(normalized)) {
          const aiChannelId = context.voiceSettings.getAiChannelId(message.guildId);
          await message.reply({
            content: aiChannelId ? `현재 AI 채팅 채널은 <#${aiChannelId}>예요...` : '현재 설정된 AI 채팅 채널이 없어요...',
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        if (['해제', '끄기', 'off', 'disable', 'unset', 'clear', 'none', '없음', '초기화'].includes(normalized)) {
          context.voiceSettings.setAiChannelId(message.guildId, undefined);
          await message.reply({ content: 'AI 채팅 채널 설정을 해제했어요...', allowedMentions: { repliedUser: false } });
          return;
        }

        const channel = resolveTargetGuildTextChannel(message, action);
        context.voiceSettings.setAiChannelId(message.guildId, channel.id);
        await message.reply({ content: `<#${channel.id}>를 AI 채팅 채널로 설정했어요...`, allowedMentions: { repliedUser: false } });
      }
    },
    {
      name: '웹검색',
      aliases: ['web-search', 'search-mode', '검색설정'],
      description: '서버 AI 웹 검색 모드를 확인하거나 변경합니다.',
      async execute(message, args, context) {
        if (!message.guildId) throw new Error('서버에서만 사용할 수 있어요...');
        const raw = args[0]?.trim();
        const current = getGuildWebSearchMode(context, message.guildId);
        if (!raw || ['현재', 'status', 'show', 'info', '조회'].includes(raw.toLowerCase())) {
          await message.reply({
            content: [
              `현재 웹 검색 모드: ${formatWebSearchMode(current)}`,
              `기본 모드: ${formatWebSearchMode(context.settings.webSearchDefaultMode)}`,
              `제공자: ${context.settings.webSearchProvider}, 상태: ${context.webSearchProvider?.status() ?? 'unavailable'}`,
              '사용 가능: disabled, explicit_only, automatic, search_first_factual',
              '서버 관리자만 변경할 수 있어요...'
            ].join('\n'),
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        if (!message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
          throw new Error('서버 관리자만 웹 검색 모드를 바꿀 수 있어요...');
        }

        const parsedMode = parseWebSearchModeArg(raw);
        if (!parsedMode) {
          throw new Error('알 수 없는 웹 검색 모드예요... disabled, explicit_only, automatic, search_first_factual 중 하나를 사용해 주세요...');
        }

        if (parsedMode === 'reset') {
          context.voiceSettings.setGuildWebSearchMode(message.guildId, undefined);
          await message.reply({
            content: `웹 검색 모드를 기본값으로 되돌렸어요... 현재 기본값은 ${formatWebSearchMode(context.settings.webSearchDefaultMode)}예요...`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        context.voiceSettings.setGuildWebSearchMode(message.guildId, parsedMode);
        await message.reply({ content: `웹 검색 모드를 ${formatWebSearchMode(parsedMode)}로 저장했어요...`, allowedMentions: { repliedUser: false } });
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
            `${prefix}ai채널 [#채널|해제] / ${prefix}ai-channel / ${prefix}ai-chat-channel / ${prefix}ai-watch / ${prefix}채널ai — AI가 자동으로 답할 채널 설정/해제...`,
            `${prefix}웹검색 [현재|disabled|explicit_only|automatic|search_first_factual|초기화] / ${prefix}web-search / ${prefix}search-mode / ${prefix}검색설정 — AI 웹 검색 모드 확인/변경... (서버 관리자만 변경 가능해요...)`,
            `${prefix}음색 [프리셋] / ${prefix}voice [preset] / ${prefix}voice-style [preset] / ${prefix}voicepreset [preset] / ${prefix}tts-voice [preset] / ${prefix}목소리 [프리셋] — 내 TTS 음색 확인/설정...`,
            `${prefix}tts엔진 [edge|gtts] / ${prefix}engine [edge|gtts] / ${prefix}tts-engine [edge|gtts] / ${prefix}ttsengine [edge|gtts] / ${prefix}엔진 [edge|gtts] — 내 TTS 엔진 확인/설정...`,
            `${prefix}시간대 [Asia/Seoul|America/Los_Angeles|해제] / ${prefix}timezone [time zone] / ${prefix}tz [time zone] — AI 시간 답변 기준 설정...`,
            `현재 프리픽스 뒤에 ?를 붙이고 공백을 넣어 AI 채팅해요... 예: \`${prefix}? 안녕\``,
            `AI 채팅 채널에서는 일반 메시지에도 AI가 답해요. 단, \`${prefix}도움말\` 같은 프리픽스 명령은 AI 대화가 아니라 명령으로 실행돼요...`,
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
  if (parsed.name === '?') return false;
  clearAgentTurnContext(message, context);
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



type TarotPresentationMessage = Extract<AgentRuntimeOutcome, { kind: 'final' }>['presentation'];

async function replyWithAgentOutcome(message: Message, outcome: Extract<AgentRuntimeOutcome, { kind: 'final' | 'clarify' | 'unavailable' | 'blocked' }>): Promise<void> {
  if (outcome.kind === 'final' && outcome.presentation) {
    await replyWithTarotPresentation(message, outcome.message, outcome.presentation);
    return;
  }
  await replyWithChunks(message, outcome.message);
}

async function replyWithTarotPresentation(message: Message, content: string, presentation: TarotPresentationMessage): Promise<void> {
  if (!presentation) {
    await replyWithChunks(message, content);
    return;
  }
  const chunks = chunkDiscordMessage(content);
  const files = (presentation.files ?? [])
    .map((file) => toTarotAttachment(file))
    .filter((file): file is AttachmentBuilder => Boolean(file))
    .slice(0, 5);
  const embed = new EmbedBuilder();
  if (presentation.title) embed.setTitle(presentation.title);
  const cardLines = (presentation.cards ?? []).map((card) => `${card.selectionNumber}. ${card.name} · ${card.orientation}`);
  const description = [presentation.summary, cardLines.length ? `카드\n${cardLines.join('\n')}` : undefined].filter(Boolean).join('\n\n');
  if (description) embed.setDescription(description.slice(0, 4000));
  const firstAttachmentName = files[0]?.name;
  if (firstAttachmentName) embed.setThumbnail(`attachment://${firstAttachmentName}`);
  const embeds = description || presentation.title ? [embed] : [];
  await message.reply({
    content: chunks[0] ?? '타로 결과예요...',
    ...(embeds.length ? { embeds } : {}),
    ...(files.length ? { files } : {}),
    allowedMentions: { parse: [], repliedUser: false }
  });
  const channel = message.channel as GuildTextBasedChannel;
  for (const chunk of chunks.slice(1)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
  }
}

function toTarotAttachment(file: { path: string; name: string }): AttachmentBuilder | null {
  if (!file.path.startsWith('assets/tarot/') || file.path.includes('..') || !file.name.endsWith('.png')) return null;
  const tarotRoot = resolve('assets/tarot');
  const absolutePath = resolve(file.path);
  if (absolutePath !== tarotRoot && !absolutePath.startsWith(`${tarotRoot}${sep}`)) return null;
  if (!existsSync(absolutePath)) {
    logger.warn('Trusted tarot attachment file is missing:', absolutePath);
    return null;
  }
  return new AttachmentBuilder(absolutePath, { name: file.name });
}

async function rememberAiExchange(context: BotContext, message: Message, prompt: string, answer: string): Promise<void> {
  const aiChat = context.aiChat as AiChatService & { rememberExchange?: (message: Message, prompt: string, answer: string) => Promise<void> };
  if (typeof aiChat.rememberExchange !== 'function') return;
  await aiChat.rememberExchange(message, prompt, answer)
    .catch((error) => logger.warn('Failed to remember AI exchange:', error));
}

function conversationContextFor(context: BotContext, message: Message): string | undefined {
  if (!message.guildId) return undefined;
  const aiChat = context.aiChat as AiChatService & { getConversationContext?: (guildId: string) => string };
  if (typeof aiChat.getConversationContext !== 'function') return undefined;
  const conversationContext = aiChat.getConversationContext(message.guildId).trim();
  return conversationContext || undefined;
}

function botVoiceChannelFor(context: BotContext, message: Message): { id: string; name?: string | null } | null {
  if (!message.guildId || !context.voice.isConnected(message.guildId)) return null;
  const channelId = context.voice.getConnectedChannelId(message.guildId);
  if (!channelId) return null;
  const channel = message.guild?.channels.cache.get(channelId);
  return { id: channelId, name: channel?.name ?? null };
}

function aiChatRuntimeContextFor(context: BotContext, message: Message): AiChatRuntimeContext {
  const member = message.member as GuildMember | null;
  const botVoiceChannel = botVoiceChannelFor(context, message);
  return {
    userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
    botVoice: {
      connected: Boolean(botVoiceChannel),
      channel: botVoiceChannel
    }
  };
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

function filterUsableHistoryEntries(
  history: Awaited<ReturnType<typeof fetchChannelHistory>>,
  currentMessageId?: string
): Awaited<ReturnType<typeof fetchChannelHistory>> {
  return history.filter((entry) => entry.id !== currentMessageId && !isInternalBotLogHistoryEntry(entry));
}

function isInternalBotLogHistoryEntry(entry: Awaited<ReturnType<typeof fetchChannelHistory>>[number]): boolean {
  if (!entry.isBot) return false;
  const content = entry.content.trim();
  if (!content) return false;
  return /(?:^|\n)guildName=/u.test(content) &&
    /(?:^|\n)userName=/u.test(content) &&
    /(?:^|\n)(?:stage|event|command|mode)=/u.test(content);
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
  const distributionChannelCount = Math.max(1, Math.min(channels.length, 5));
  const perChannelLimit = Math.max(1, Math.min(options.limit, Math.ceil(options.limit / distributionChannelCount)));
  const perChannelMaxResults = Math.max(perChannelLimit, Math.ceil(MAX_HISTORY_MESSAGE_LIMIT / distributionChannelCount));
  const settled = await Promise.allSettled(
    channels.map((channel) =>
      fetchChannelHistory(channel, {
        limit: perChannelLimit,
        lookbackHours: options.lookbackHours,
        maxResults: perChannelMaxResults
      })
    )
  );

  const combined = filterUsableHistoryEntries(
    settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    message.id
  );
  return combined
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
    .slice(0, MAX_HISTORY_MESSAGE_LIMIT)
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
    const history = filterUsableHistoryEntries(await searchGuildMessages({
      guildId: message.guildId,
      botToken,
      query,
      channelIds: options.channelIds,
      limit: options.limit
    }), message.id);
    return { history, source: 'discord-search' };
  } catch (error) {
    logger.warn('Discord indexed message search failed; falling back to recent fetch:', error);
    const details = extractErrorDetails(error);
    return { history: [], source: 'recent-fetch', error: details.errorMessage ?? String(error) };
  }
}


async function createAndReplyConfirmation(
  message: Message,
  context: BotContext,
  confirmations: ConfirmationManager,
  intent: ConfirmationScope['intent'],
  preview: string,
  normalizedArgs: string,
  commandQuery: string
): Promise<void> {
  if (!message.guildId) return;
  const scope: ConfirmationScope = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    intent,
    targetChannelId: extractLeadingChannelReference(normalizedArgs),
    normalizedArgs,
    commandQuery
  };
  const confirmation = confirmations.create(scope, preview);
  await message.reply({
    content: await buildConfirmationMessage(message, context, preview, confirmation.expiresAt, commandQuery),
    allowedMentions: { repliedUser: false }
  });
}

async function buildConfirmationMessage(
  message: Message,
  context: BotContext,
  preview: string,
  expiresAt: number,
  commandQuery: string
): Promise<string> {
  const expiresTag = `<t:${Math.floor(expiresAt / 1000)}:R>`;
  if (!shouldUseAiConfirmationMessage(commandQuery)) return safeConfirmationFallback(preview, expiresTag);
  const messages: AiChatMessage[] = buildConfirmationPromptMessages(preview, commandQuery, expiresTag);
  for (let attempt = 1; attempt <= CONFIRMATION_MESSAGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await context.ai.askMessagesDetailed({
        guildId: message.guildId ?? 'dm',
        userId: message.author.id,
        usageScope: 'agent',
        maxCompletionTokens: 120,
        messages
      });
      const validation = validateConfirmationMessage(response.content);
      if (validation.ok) return validation.content;
      messages.push(
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            `방금 응답은 사용자에게 보낼 수 없어요: ${validation.reason}`,
            '내부 오류/빈 응답/토큰/JSON 없이, 상황에 맞는 확인 질문을 자연스럽게 다시 작성하세요.',
            `확인할 작업: ${preview}`,
            `만료: ${expiresTag}`
          ].join('\n')
        }
      );
    } catch (error) {
      logger.warn('Failed to generate confirmation message with AI; retrying or using safe fallback:', error);
      messages.push({
        role: 'user',
        content: [
          '이전 확인 안내 생성 호출이 실패했어요.',
          '사용자에게 보낼 자연스러운 확인 질문만 다시 작성하세요.',
          `확인할 작업: ${preview}`,
          `만료: ${expiresTag}`
        ].join('\n')
      });
    }
  }
  return safeConfirmationFallback(preview, expiresTag);
}

function buildConfirmationPromptMessages(preview: string, commandQuery: string, expiresTag: string): AiChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '너는 Discord 봇 초코코봇의 확인 안내 문구 작성자예요.',
        '사용자에게 보낼 자연스러운 한국어 확인 질문 한 개만 작성해요.',
        '고정 템플릿처럼 쓰지 말고 상황에 맞게 말투를 자연스럽게 바꿔요.',
        '내부 확인 토큰, UUID, 처리 흐름, JSON, 코드펜스는 절대 쓰지 마세요.',
        '아직 실행된 것처럼 말하지 말고, 진행해도 되는지 확인하는 문장이어야 해요.',
        '사용자가 승인/거절을 자연스럽게 답할 수 있음을 짧게 알려도 돼요.',
        `확인 만료 시각을 언급한다면 Discord timestamp ${expiresTag}를 그대로 사용하세요.`
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `확인할 작업: ${preview}`,
        `실행될 기존 명령: ${commandQuery}`,
        `만료: ${expiresTag}`
      ].join('\n')
    }
  ];
}

function validateConfirmationMessage(content: string): { ok: true; content: string } | { ok: false; reason: string } {
  const cleaned = content
    .replace(/```(?:\w+)?/g, '')
    .replace(/```/g, '')
    .trim()
    .slice(0, 900);
  if (!cleaned || cleaned === '응답이 비어 있어요...') {
    return { ok: false, reason: '빈 응답이에요.' };
  }
  if (/확인\s*토큰|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(cleaned)) {
    return { ok: false, reason: '내부 확인 토큰이 노출됐어요.' };
  }
  if (/^\s*\{[\s\S]*\}\s*$/u.test(cleaned)) {
    return { ok: false, reason: '사용자용 문장이 아니라 JSON이에요.' };
  }
  if (!/(진행|괜찮|될까요|할까요|하시겠|승인|확인|답해|원하)/u.test(cleaned)) {
    return { ok: false, reason: '확인 질문이 아니라 실행 완료처럼 보이는 문장이에요.' };
  }
  return { ok: true, content: cleaned };
}

function safeConfirmationFallback(preview: string, expiresTag: string): string {
  return `${preview}\n진행해도 되는지 답해 주세요. ${expiresTag}까지 기다릴게요.`;
}

function shouldUseAiConfirmationMessage(commandQuery: string): boolean {
  return !/^(?:청소|대청소)(?:\s|$)/u.test(commandQuery.trim());
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
    case 'ai-channel':
      return 'AI 채팅 채널 설정을 바꿀까요?';
    case 'web-search':
      return '웹 검색 모드를 바꿀까요?';
    default:
      return '이 명령을 실행할까요?';
  }
}

function requiresAdministratorForConfirmation(intent: ConfirmationScope['intent'] | undefined): boolean {
  return intent === 'prefix-change'
    || intent === 'memory-reset'
    || intent === 'watch-channel'
    || intent === 'ai-channel'
    || intent === 'web-search';
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

function isNativeToolCallLeakError(error: unknown): boolean {
  return /Tool choice is none, but model called a tool/iu.test(extractErrorDetails(error).errorMessage);
}

async function logAgentDiagnostic(
  message: Message,
  context: BotContext,
  details: AgentRuntimeDiagnostic
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
    stage: details.stage,
    event: details.event,
    runId: details.runId,
    iteration: details.iteration,
    toolCallId: details.toolCallId,
    toolName: details.toolName,
    policy: details.policy,
    observationSummary: details.observationSummary,
    model: details.model,
    usageScope: details.usageScope ?? (details.stage === 'agent' ? 'agent' : undefined),
    decisionKind: details.decisionKind,
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
  }).catch((error) => logger.warn('Failed to log agent diagnostic:', error));
}

async function dispatchPlannerCommand(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager,
  query: string,
  options: { allowUserCleanupWithoutConfirmation?: boolean } = {}
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

  if (options.allowUserCleanupWithoutConfirmation && safety.level === 'needs-confirmation' && safety.intent === 'cleanup') {
    return dispatchCommandQuery(message, commands, context, query);
  }

  if (safety.level === 'needs-confirmation' || safety.level === 'destructive') {
    if (!safety.intent) {
      await message.reply({ content: '이 명령은 확인이 필요해요... 어떤 작업인지 다시 말해 주세요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    if (requiresAdministratorForConfirmation(safety.intent) && !message.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await message.reply({ content: '서버 관리자만 이 설정을 바꿀 수 있어요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    if (safety.intent === 'cleanup' && safety.level === 'destructive' && !hasManageMessages(message.member?.permissions)) {
      await message.reply({ content: '이 작업은 관리자 권한이 필요해요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    await createAndReplyConfirmation(message, context, confirmations, safety.intent, confirmationPreviewForSafety(safety), safety.args.join(' ').trim(), safety.normalizedQuery);
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
    const isTopicLookup = Boolean(queryTopic && route.mode === 'qa');
    const searchLimit = queryTopic && assessment.limit === DEFAULT_HISTORY_MESSAGE_LIMIT ? MAX_HISTORY_MESSAGE_LIMIT : assessment.limit;
    const searchLookbackHours = queryTopic && assessment.lookbackHours === DEFAULT_HISTORY_LOOKBACK_HOURS ? MAX_HISTORY_LOOKBACK_HOURS : assessment.lookbackHours;
    const indexedSearch = queryTopic
      ? await searchIndexedGuildTextHistory(message, context, route.query, { limit: searchLimit, channelIds: [targetChannel.id] })
      : { history: [], source: 'disabled' as const };
    const history = indexedSearch.history.length ? indexedSearch.history : filterUsableHistoryEntries(await fetchChannelHistory(targetChannel, {
      limit: searchLimit,
      lookbackHours: searchLookbackHours
    }), message.id);
    const filteredHistory = isTopicLookup ? filterHistoryByQuery(history, route.query) : history;
    const usedHistory = isTopicLookup
      ? (filteredHistory.length ? filteredHistory : history)
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
    await rememberAiExchange(context, message, route.query, answer);
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
      ? '지금 AI 요청이 몰려서 잠시 지연되고 있어요... 조금 뒤에 다시 시도해 주세요...'
      : details.errorMessage || '채널 기록을 확인하지 못했어요... 다시 시도해 주세요...';
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  }
  return true;
}

async function executeHistorySearchTool(
  message: Message,
  context: BotContext,
  input: HistorySearchInput
): Promise<HistorySearchOutput> {
  if (!message.guildId) throw new Error('서버에서만 대화 기록을 검색할 수 있어요...');
  const assessment = assessChannelHistoryQuery(input.query);
  if (assessment.status !== 'ready') throw new Error(assessment.prompt);

  const queryTopic = input.query.trim() || null;
  const isTopicLookup = Boolean(queryTopic && input.mode === 'qa');
  const baseLimit = Math.min(input.limit ?? assessment.limit, MAX_HISTORY_MESSAGE_LIMIT);
  const searchLimit = queryTopic && baseLimit === DEFAULT_HISTORY_MESSAGE_LIMIT ? MAX_HISTORY_MESSAGE_LIMIT : baseLimit;
  const searchLookbackHours = queryTopic && assessment.lookbackHours === DEFAULT_HISTORY_LOOKBACK_HOURS ? MAX_HISTORY_LOOKBACK_HOURS : assessment.lookbackHours;

  if (input.scope === 'channel') {
    const targetChannel = resolveTargetGuildTextChannel(message, input.channelRef);
    if (isLoggingGuild(message, context) && isManagedLogTextChannel(targetChannel) && !canAccessLoggingHistory(message)) {
      throw new Error('로그 채널 내용은 관리자만 확인할 수 있어요...');
    }
    const indexedSearch = queryTopic
      ? await searchIndexedGuildTextHistory(message, context, input.query, { limit: searchLimit, channelIds: [targetChannel.id] })
      : { history: [], source: 'disabled' as const };
    const history = indexedSearch.history.length ? indexedSearch.history : filterUsableHistoryEntries(await fetchChannelHistory(targetChannel, {
      limit: searchLimit,
      lookbackHours: searchLookbackHours
    }), message.id);
    const filteredHistory = isTopicLookup ? filterHistoryByQuery(history, input.query) : history;
    const usedHistory = isTopicLookup
      ? (filteredHistory.length ? filteredHistory : history)
      : history;
    await context.activityLog.logChannelHistory({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      mode: input.mode,
      query: input.query,
      topic: queryTopic,
      targetChannelId: targetChannel.id,
      searchSource: indexedSearch.history.length ? indexedSearch.source : 'recent-fetch',
      searchError: indexedSearch.error,
      scannedChannels: 1,
      matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
      usedMessages: usedHistory.length
    }).catch((logError) => logger.warn('Failed to log agent history.search result:', logError));
    return {
      scope: 'channel',
      channelId: targetChannel.id,
      query: input.query,
      scannedChannels: 1,
      matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
      usedMessages: usedHistory.length,
      evidence: selectLatestHistoryEvidence(usedHistory)
    };
  }

  if (isLoggingGuild(message, context) && !canAccessLoggingHistory(message)) {
    throw new Error('로그 서버의 전체 대화 검색은 관리자만 사용할 수 있어요...');
  }
  const searchableChannels = searchableHistoryChannels(message, context);
  const searchableChannelIds = isLoggingGuild(message, context) ? searchableChannels.map((channel) => channel.id) : undefined;
  const indexedSearch = queryTopic
    ? await searchIndexedGuildTextHistory(message, context, input.query, { limit: searchLimit, channelIds: searchableChannelIds })
    : { history: [], source: 'disabled' as const };
  const history = indexedSearch.history.length ? indexedSearch.history : await fetchRecentGuildTextHistory(message, context, {
    limit: searchLimit,
    lookbackHours: searchLookbackHours
  });
  const filteredHistory = isTopicLookup ? filterHistoryByQuery(history, input.query) : history;
  const usedHistory = isTopicLookup
    ? (filteredHistory.length ? filteredHistory : history)
    : history;
  await context.activityLog.logChannelHistory({
    guildId: message.guildId,
    guildName: message.guild?.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.username,
    mode: input.mode,
    query: input.query,
    topic: queryTopic,
    searchSource: indexedSearch.history.length ? indexedSearch.source : 'recent-fetch',
    searchError: indexedSearch.error,
    scannedChannels: Math.min(MAX_AUTO_HISTORY_CHANNELS, searchableChannels.length),
    matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
    usedMessages: usedHistory.length
  }).catch((logError) => logger.warn('Failed to log agent history.search result:', logError));
  return {
    scope: 'server',
    query: input.query,
    scannedChannels: Math.min(MAX_AUTO_HISTORY_CHANNELS, searchableChannels.length),
    matchedMessages: isTopicLookup ? filteredHistory.length : history.length,
    usedMessages: usedHistory.length,
    evidence: selectLatestHistoryEvidence(usedHistory)
  };
}


function resolveTarotToolContext(executionContext: AgentToolExecutionContext): { message: Message; context: BotContext } {
  const message = executionContext.message as Message | undefined;
  const context = executionContext.botContext as BotContext | undefined;
  if (!message || !context) {
    throw new AgentToolExecutionError(
      'tarot_context_missing',
      '타로 도구 실행 문맥을 찾지 못했어요.',
      'Retry only when the runtime provides the triggering Discord message and bot context.'
    );
  }
  return { message, context };
}

async function executeTarotStartReadingTool(input: TarotStartReadingInput, executionContext: AgentToolExecutionContext): Promise<TarotStartReadingOutput> {
  const { message, context } = resolveTarotToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버 채널에서만 타로를 볼 수 있어요.', 'Ask the user to use tarot in a server text channel.');
  }
  if (!context.tarotSessions) {
    throw new AgentToolExecutionError('tarot_store_unavailable', '타로 세션 저장소를 사용할 수 없어요.', 'Tell the user to retry later.');
  }
  const key = tarotSessionKeyFor(message);
  if (!key) {
    throw new AgentToolExecutionError('guild_required', '서버 채널에서만 타로를 볼 수 있어요.', 'Ask the user to use tarot in a server text channel.');
  }
  const session = context.tarotSessions.start(key, {
    topic: input.topic,
    spreadCount: input.spreadCount,
    ...(input.spreadName ? { spreadName: input.spreadName } : {}),
    requesterDisplayName: requesterDisplayName(message)
  }, executionContext.nowMs);
  const spreadLabel = input.spreadName ? `${input.spreadName}으로 ` : '';
  return {
    sessionId: `${key.guildId}:${key.channelId}:${key.userId}`,
    topic: session.topic,
    spreadCount: session.spreadCount,
    ...(session.spreadName ? { spreadName: session.spreadName } : {}),
    expiresAt: session.expiresAt,
    message: `${session.topic} 주제로 ${spreadLabel}${session.spreadCount}장 볼게요. 1~78 사이 숫자 ${session.spreadCount}개를 중복 없이 골라주세요.`
  };
}

async function executeTarotRevealSelectionTool(input: TarotRevealSelectionInput, executionContext: AgentToolExecutionContext): Promise<TarotRevealSelectionOutput> {
  const { message, context } = resolveTarotToolContext(executionContext);
  const key = tarotSessionKeyFor(message);
  if (!key || !context.tarotSessions) {
    throw new AgentToolExecutionError('tarot_session_not_found', '진행 중인 타로 선택을 찾지 못했어요. 먼저 타로를 봐달라고 요청해 주세요.', 'Start a tarot reading before revealing card numbers.', 'error', 'numbers');
  }
  const session = context.tarotSessions.get(key, executionContext.nowMs);
  if (!session) {
    throw new AgentToolExecutionError('tarot_session_not_found', '진행 중인 타로 선택을 찾지 못했어요. 먼저 타로를 봐달라고 요청해 주세요.', 'Start a tarot reading before revealing card numbers.', 'error', 'numbers');
  }
  const validation = validateTarotSelectionNumbers(input.numbers, session.spreadCount);
  if (!validation.ok) {
    throw new AgentToolExecutionError(validation.code, validation.message, validation.hint, 'error', validation.field);
  }
  const consumed = context.tarotSessions.consume(key, executionContext.nowMs) ?? session;
  const drawn = drawTarotCardsFromNumbers(validation.numbers, consumed.deckOrder);
  const bars = formatTarotEnergyBars(drawn);
  const cards = drawn.map((item) => ({
    selectionNumber: item.selectionNumber,
    nameKo: item.card.nameKo,
    nameEn: item.card.nameEn,
    orientation: item.orientation,
    orientationKo: item.orientation === 'reversed' ? '역방향' : '정방향',
    keywords: item.card.keywords,
    assetPath: item.assetPath,
    attachmentName: item.attachmentName
  }));
  return {
    message: `${consumed.topic} 타로 카드 ${drawn.length}장을 확인했어요. 관찰값의 카드, 방향, 키워드, 그래프를 근거로 해석해 주세요.`,
    topic: consumed.topic,
    spreadCount: consumed.spreadCount,
    selectedNumbers: validation.numbers,
    cards,
    visualData: { bars },
    presentation: {
      title: `${consumed.topic} 타로`,
      summary: bars,
      files: drawn.map((item) => ({ path: item.assetPath, name: item.attachmentName })),
      cards: cards.map((card) => ({
        selectionNumber: card.selectionNumber,
        name: card.nameKo,
        orientation: card.orientationKo,
        attachmentName: card.attachmentName
      }))
    }
  };
}

function resolveVoiceToolContext(executionContext: AgentToolExecutionContext): { message: Message; context: BotContext } {
  const message = executionContext.message as Message | undefined;
  const context = executionContext.botContext as BotContext | undefined;
  if (!message || !context) {
    throw new AgentToolExecutionError(
      'voice_context_missing',
      'Voice tool execution context is unavailable.',
      'Retry only when the runtime provides the triggering Discord message and bot context.'
    );
  }
  return { message, context };
}

async function executeVoiceJoinTool(_input: Record<string, never>, executionContext: AgentToolExecutionContext): Promise<{ message: string; channelId?: string }> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  const member = requireGuildMember(message);
  if (!member.voice.channel) {
    throw new AgentToolExecutionError('user_not_in_voice', '먼저 음성 채널에 들어가 주세요...', 'Ask the user to join a voice channel first.');
  }
  await context.voice.join(member);
  await context.activityLog.logVoiceConnection({
    guildId: message.guildId,
    guildName: message.guild?.name,
    channelId: member.voice.channel.id,
    message: 'voice joined'
  });
  return { message: '음성 채널에 연결했어요...', channelId: member.voice.channel.id };
}

async function executeVoiceLeaveTool(_input: Record<string, never>, executionContext: AgentToolExecutionContext): Promise<{ message: string }> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  if (!context.voice.isConnected(message.guildId)) {
    throw new AgentToolExecutionError('voice_not_connected', '봇이 음성 채널에 연결되어 있지 않아요...', 'Explain that the bot is not currently connected to a voice channel.');
  }
  context.voice.leave(message.guildId);
  await context.activityLog.logVoiceConnection({
    guildId: message.guildId,
    guildName: message.guild?.name,
    message: 'voice left'
  });
  return { message: '음성 채널에서 나왔어요...' };
}

async function executeVoiceStopTool(_input: Record<string, never>, executionContext: AgentToolExecutionContext): Promise<VoiceStopOutput> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  if (!context.voice.isConnected(message.guildId)) {
    throw new AgentToolExecutionError('voice_not_connected', '봇이 음성 채널에 연결되어 있지 않아요...', 'Explain that the bot is not currently connected to a voice channel.');
  }
  const stopped = context.voice.stopPlayback(message.guildId);
  return { message: '재생을 멈췄어요...', stopped };
}

async function executeVoiceSpeakTool(input: VoiceSpeakInput, executionContext: AgentToolExecutionContext): Promise<VoiceSpeakOutput> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  if (input.text.length > MAX_TTS_COMMAND_CHARS) {
    throw new AgentToolExecutionError('validation_error', `한 번에 ${MAX_TTS_COMMAND_CHARS}자까지만 읽을 수 있어요...`, 'Shorten the text before calling voice.speak again.', 'error', 'text');
  }
  const member = requireGuildMember(message);
  let autoJoined = false;
  let channelId = member.voice.channel?.id;
  if (!context.voice.isConnected(message.guildId)) {
    if (!member.voice.channel) {
      throw new AgentToolExecutionError('user_not_in_voice', '먼저 음성 채널에 들어가 주세요...', 'Ask the user to join a voice channel first.');
    }
    await context.voice.join(member);
    autoJoined = true;
    channelId = member.voice.channel.id;
    await context.activityLog.logVoiceConnection({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId,
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
    text: input.text
  });
  const played = await context.voice.speak(message.guildId, input.text, message.author.id);
  if (!played) {
    const voiceError = context.voice.getLastError(message.guildId);
    await context.activityLog.logError({
      guildId: message.guildId,
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: message.author.username,
      commandName: 'voice.speak',
      summary: `text=${input.text.slice(0, 500)}`,
      error: new Error(voiceError ? `TTS synthesis/playback failed: ${voiceError}` : 'TTS synthesis/playback failed')
    });
    throw new AgentToolExecutionError('tts_playback_failed', voiceError ?? 'TTS synthesis/playback failed', 'Tell the user voice playback failed and suggest retrying later.');
  }
  return { message: '음성으로 말했어요...', text: input.text, autoJoined, channelId };
}

async function executeTtsVoicePresetTool(input: TtsVoicePresetInput, executionContext: AgentToolExecutionContext): Promise<TtsVoicePresetOutput> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  const available = context.voice.listVoicePresets();
  if (input.action === 'status') {
    const current = context.voice.getUserVoicePreset(message.guildId, message.author.id) ?? '기본값';
    return { message: `현재 음색은 ${current}예요... 사용 가능: ${available.join(', ')}`, current, available };
  }
  try {
    context.voice.setUserVoicePreset(message.guildId, message.author.id, input.preset ?? '');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new AgentToolExecutionError('validation_error', errorMessage, `Choose one of: ${available.join(', ')}`, 'error', 'preset');
  }
  return { message: `내 TTS 음색을 ${input.preset}로 저장했어요...`, current: input.preset, available };
}

async function executeTtsEngineTool(input: TtsEngineInput, executionContext: AgentToolExecutionContext): Promise<TtsEngineOutput> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  const available = context.voice.listTtsEngines();
  if (input.action === 'status') {
    const current = context.voice.getUserTtsEngine(message.guildId, message.author.id);
    return { message: `현재 엔진은 ${current}예요... 사용 가능: ${available.join(', ')}`, current, available };
  }
  if (input.action === 'clear') {
    context.voice.clearUserTtsEngine(message.guildId, message.author.id);
    const current = context.voice.getUserTtsEngine(message.guildId, message.author.id);
    return { message: 'TTS 엔진 설정을 기본값으로 되돌렸어요...', current, available };
  }
  const engine = normalizeTtsEngineName(input.engine ?? '');
  if (!engine) {
    throw new AgentToolExecutionError('validation_error', `알 수 없는 TTS 엔진이에요. 사용 가능: ${available.join(', ')}`, `Choose one of: ${available.join(', ')}`, 'error', 'engine');
  }
  context.voice.setUserTtsEngine(message.guildId, message.author.id, engine);
  return { message: `내 TTS 엔진을 ${engine}로 저장했어요...`, current: engine, available };
}

async function executeUserTimezoneTool(input: UserTimezoneInput, executionContext: AgentToolExecutionContext): Promise<UserTimezoneOutput> {
  const { message, context } = resolveVoiceToolContext(executionContext);
  if (!message.guildId) {
    throw new AgentToolExecutionError('guild_required', '서버에서만 사용할 수 있어요...', 'Ask the user to use this in a server channel.');
  }
  if (input.action === 'status') {
    const current = context.voiceSettings.getUserTimeZone(message.guildId, message.author.id);
    return {
      message: current
        ? `내 시간대는 ${current}예요...`
        : `내 시간대가 아직 없어요... 지금 시간 질문은 ${context.settings.botTimeZone} 기준으로 답해요...`,
      ...(current ? { current } : {}),
      defaultTimeZone: context.settings.botTimeZone
    };
  }
  if (input.action === 'clear') {
    context.voiceSettings.setUserTimeZone(message.guildId, message.author.id, undefined);
    return {
      message: `시간대 설정을 지웠어요... 이제 ${context.settings.botTimeZone} 기준으로 답해요...`,
      defaultTimeZone: context.settings.botTimeZone
    };
  }
  if (!input.timeZone || !isValidTimeZone(input.timeZone)) {
    throw new AgentToolExecutionError('validation_error', '알 수 없는 시간대예요... 예: Asia/Seoul, America/Los_Angeles, America/New_York', 'Use a valid IANA time zone such as Asia/Seoul.', 'error', 'timeZone');
  }
  context.voiceSettings.setUserTimeZone(message.guildId, message.author.id, input.timeZone);
  return {
    message: `내 시간대를 ${input.timeZone}로 저장했어요...`,
    current: input.timeZone,
    defaultTimeZone: context.settings.botTimeZone
  };
}

function toHistoryEvidence(entry: Awaited<ReturnType<typeof fetchChannelHistory>>[number]): HistorySearchOutput['evidence'][number] {
  return {
    channelId: entry.channelId,
    authorName: entry.authorName,
    timestamp: new Date(entry.createdTimestamp).toISOString(),
    content: entry.content
  };
}

export function selectLatestHistoryEvidence(
  history: readonly ChannelHistoryEntry[],
  limit = 20
): HistorySearchOutput['evidence'] {
  return history.slice(-limit).map(toHistoryEvidence);
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
    const isTopicLookup = Boolean(queryTopic && mode === 'qa');
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
      ? (filteredHistory.length ? filteredHistory : history)
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
    await rememberAiExchange(context, message, query, answer);
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
      ? '지금 AI 요청이 몰려서 잠시 지연되고 있어요... 조금 뒤에 다시 시도해 주세요...'
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
        normalizedArgs: route.normalizedArgs,
        commandQuery: route.query
      };
      const confirmation = confirmations.create(scope, route.preview);
      await message.reply({
        content: await buildConfirmationMessage(message, context, route.preview, confirmation.expiresAt, route.query),
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

function buildTimeMemoryPrompt(plan: Extract<import('./services/aiCommandPlanner.js').AiCommandPlan, { kind: 'time' }>): string {
  if (plan.target === 'viewer') return `time viewer offsetSeconds=${plan.offsetSeconds ?? 0}`;
  return `time zone=${plan.timeZone ?? ''} label=${plan.label ?? ''} offsetSeconds=${plan.offsetSeconds ?? 0}`;
}

async function handleTimePlan(message: Message, plan: Extract<import('./services/aiCommandPlanner.js').AiCommandPlan, { kind: 'time' }>, context: BotContext): Promise<boolean> {
  const answer = buildTimePlanReply(message, plan);
  await message.reply({ content: answer, allowedMentions: { parse: [], repliedUser: false } });
  await rememberAiExchange(context, message, buildTimeMemoryPrompt(plan), answer);
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

function latestConfirmationForMessage(message: Message, confirmations: ConfirmationManager): PendingConfirmation | undefined {
  if (!message.guildId) return undefined;
  return confirmations.latestForActor({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id
  });
}

function pendingConfirmationPromptContext(pending: PendingConfirmation | undefined): AgentConfirmationContext | null {
  if (!pending) return null;
  return {
    preview: pending.preview,
    commandQuery: pending.commandQuery,
    intent: pending.intent,
    normalizedArgs: pending.normalizedArgs
  };
}

type AgentConfirmationContext = {
  preview: string;
  commandQuery: string;
  intent: string;
  normalizedArgs: string;
};

async function handleAiCommandPlannerPrompt(
  message: Message,
  prompt: string,
  prefix: string,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager,
  pendingHistoryRequest: PendingChannelHistoryRequest | undefined,
  pendingConfirmation: PendingConfirmation | undefined
): Promise<boolean> {
  if (!message.guildId || !context.aiCommandPlanner) return false;
  try {
    const member = message.member as GuildMember | null;
    const plan = await context.aiCommandPlanner.plan(message, prompt, {
      prefix,
      commands,
      availableChannels: listTextChannelCandidates(message),
      userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
      botVoiceConnected: context.voice.isConnected(message.guildId),
      botVoiceChannel: botVoiceChannelFor(context, message),
      maxCompletionTokens: context.settings.aiPlannerMaxCompletionTokens,
      pendingHistory: pendingHistoryRequest ? { mode: pendingHistoryRequest.mode, query: pendingHistoryRequest.query } : null,
      pendingConfirmation: pendingConfirmationPromptContext(pendingConfirmation),
      conversationContext: conversationContextFor(context, message),
      onDiagnostic: (details) => logPlannerDiagnostic(message, context, details)
    });
    switch (plan.kind) {
      case 'chat':
        if (await handlePendingChannelHistoryReply(message, prompt, context)) return true;
        await context.aiChat.handlePrompt(message, prompt);
        return true;
      case 'command':
        return dispatchPlannerCommand(message, commands, context, confirmations, plan.query, {
          allowUserCleanupWithoutConfirmation: !context.settings.aiConfirmOwnCleanup
        });
      case 'confirm_pending':
        if (!pendingConfirmation) {
          await context.aiChat.handlePrompt(message, prompt);
          return true;
        }
        return dispatchConfirmedPendingCommand(message, commands, context, confirmations);
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
        if (pendingHistoryRequest && await handlePendingChannelHistoryReply(message, prompt, context)) return true;
        await message.reply({ content: plan.message, allowedMentions: { repliedUser: false } });
        await rememberAiExchange(context, message, prompt, plan.message);
        return true;
      case 'unavailable':
        await message.reply({ content: plan.message, allowedMentions: { repliedUser: false } });
        await rememberAiExchange(context, message, prompt, plan.message);
        return true;
    }
  } catch (error) {
    if (isRateLimitLike(error)) {
      await logPlannerDiagnostic(message, context, { event: 'rate_limit', error });
      await message.reply({ content: '지금 AI 요청이 몰려서 잠시 지연되고 있어요... 조금 뒤에 다시 시도해 주세요...', allowedMentions: { repliedUser: false } });
      return true;
    }
    await logPlannerDiagnostic(message, context, { event: 'error', error });
    await context.aiChat.handlePrompt(message, prompt);
    return true;
  }
}

async function handleReadOnlyPlannerFallbackPrompt(
  message: Message,
  prompt: string,
  prefix: string,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  pendingHistoryRequest: PendingChannelHistoryRequest | undefined,
  pendingConfirmation: PendingConfirmation | undefined
): Promise<boolean> {
  if (!message.guildId || !context.aiCommandPlanner) return false;
  try {
    const member = message.member as GuildMember | null;
    const plan = await context.aiCommandPlanner.plan(message, prompt, {
      prefix,
      commands,
      availableChannels: listTextChannelCandidates(message),
      userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
      botVoiceConnected: context.voice.isConnected(message.guildId),
      botVoiceChannel: botVoiceChannelFor(context, message),
      maxCompletionTokens: context.settings.aiPlannerMaxCompletionTokens,
      pendingHistory: pendingHistoryRequest ? { mode: pendingHistoryRequest.mode, query: pendingHistoryRequest.query } : null,
      pendingConfirmation: pendingConfirmationPromptContext(pendingConfirmation),
      conversationContext: conversationContextFor(context, message),
      onDiagnostic: (details) => logPlannerDiagnostic(message, context, details)
    });

    switch (plan.kind) {
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
      case 'unavailable':
        await message.reply({ content: plan.message, allowedMentions: { repliedUser: false } });
        await rememberAiExchange(context, message, prompt, plan.message);
        return true;
      case 'chat':
      case 'command':
      case 'confirm_pending':
        return false;
    }
  } catch (error) {
    await logPlannerDiagnostic(message, context, { event: isRateLimitLike(error) ? 'rate_limit' : 'error', error });
    return false;
  }
}

async function dispatchConfirmedPendingCommand(
  message: Message,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager
): Promise<boolean> {
  if (!message.guildId) return false;
  const pending = confirmations.consumeLatestForActor({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id
  });
  if (!pending) {
    await message.reply({ content: '확인할 대기 작업을 찾지 못했어요...', allowedMentions: { repliedUser: false } });
    return true;
  }
  return dispatchCommandQuery(message, commands, context, pending.commandQuery);
}

async function handleAiPrompt(
  message: Message,
  prompt: string,
  prefix: string,
  routedContent: string,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager
): Promise<boolean> {
  if (!message.guildId) return false;
  const pendingConfirmation = latestConfirmationForMessage(message, confirmations);
  const pendingHistoryRequest = getPendingChannelHistoryRequest(message);
  if (context.agentRuntime) {
    try {
      const member = message.member as GuildMember | null;
      const outcome = await context.agentRuntime.run(message, prompt, {
        prefix,
        requesterDisplayName: requesterDisplayName(message),
        commands: uniqueCommandDefinitions(commands),
        availableChannels: listTextChannelCandidates(message),
        userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
        botVoiceConnected: context.voice.isConnected(message.guildId),
        botVoiceChannel: botVoiceChannelFor(context, message),
        maxCompletionTokens: context.settings.aiPlannerMaxCompletionTokens,
        pendingHistory: pendingHistoryRequest ? { mode: pendingHistoryRequest.mode, query: pendingHistoryRequest.query } : null,
        pendingConfirmation: pendingConfirmationPromptContext(pendingConfirmation),
        conversationContext: conversationContextFor(context, message),
        tarotPending: tarotPendingFor(message, context),
        webSearch: {
          mode: getGuildWebSearchMode(context, message.guildId),
          provider: context.settings.webSearchProvider,
          providerStatus: context.webSearchProvider?.status() ?? 'unavailable',
          resultCount: context.settings.webSearchResultCount
        },
        executionContext: {
          nowMs: message.createdTimestamp,
          message,
          botContext: context,
          runtime: {
            prefix,
            currentChannelId: message.channelId,
            requesterDisplayName: requesterDisplayName(message),
            availableChannels: listTextChannelCandidates(message),
            userVoiceChannel: member?.voice?.channel ? { id: member.voice.channel.id, name: member.voice.channel.name } : null,
            botVoiceConnected: context.voice.isConnected(message.guildId),
            botVoiceChannel: botVoiceChannelFor(context, message),
            voiceSemantics: {
              userVoice: 'requester_voice_channel_not_bot_location',
              botVoice: 'botVoiceConnected_and_botVoiceChannel_are_bot_location_source_of_truth'
            },
            tarotPending: tarotPendingFor(message, context),
            webSearch: {
              mode: getGuildWebSearchMode(context, message.guildId),
              provider: context.settings.webSearchProvider,
              providerStatus: context.webSearchProvider?.status() ?? 'unavailable',
              resultCount: context.settings.webSearchResultCount
            }
          }
        },
        onDiagnostic: (details) => logAgentDiagnostic(message, context, details)
      });
      switch (outcome.kind) {
        case 'final':
        case 'clarify':
        case 'unavailable':
        case 'blocked':
          clearPendingChannelHistoryRequest(message);
          if (outcome.kind === 'clarify') rememberTarotClarifySession(message, context, outcome);
          await replyWithAgentOutcome(message, outcome);
          await rememberAiExchange(context, message, prompt, outcome.message);
          return true;
        case 'confirmation_required':
          clearPendingChannelHistoryRequest(message);
          return dispatchPlannerCommand(message, commands, context, confirmations, outcome.commandQuery, {
            allowUserCleanupWithoutConfirmation: !context.settings.aiConfirmOwnCleanup
          });
        case 'confirm_pending':
          if (pendingConfirmation) return dispatchConfirmedPendingCommand(message, commands, context, confirmations);
          if (await handleAiCommandPlannerPrompt(message, prompt, prefix, commands, context, confirmations, pendingHistoryRequest, pendingConfirmation)) return true;
          await context.aiChat.handlePrompt(message, prompt);
          return true;
        case 'not_handled':
          if (await handlePendingChannelHistoryReply(message, prompt, context)) return true;
          if (await handleAiCommandPlannerPrompt(message, prompt, prefix, commands, context, confirmations, pendingHistoryRequest, pendingConfirmation)) return true;
          await context.aiChat.handlePrompt(message, prompt);
          return true;
      }
    } catch (error) {
      if (isRateLimitLike(error)) {
        await logAgentDiagnostic(message, context, { stage: 'agent', event: 'rate_limit', error });
        await message.reply({ content: '지금 AI 요청이 몰려서 잠시 지연되고 있어요... 조금 뒤에 다시 시도해 주세요...', allowedMentions: { repliedUser: false } });
        return true;
      }
      await logAgentDiagnostic(message, context, {
        stage: 'agent',
        event: 'error',
        error,
        decisionKind: isNativeToolCallLeakError(error) ? 'agent_native_tool_call_leak' : undefined
      });
      if (await handlePendingChannelHistoryReply(message, prompt, context)) return true;
      if (isNativeToolCallLeakError(error) && await handleReadOnlyPlannerFallbackPrompt(message, prompt, prefix, commands, context, pendingHistoryRequest, pendingConfirmation)) return true;
      await context.aiChat.handlePrompt(message, prompt);
      return true;
    }
  }
  if (await handleAiCommandPlannerPrompt(message, prompt, prefix, commands, context, confirmations, pendingHistoryRequest, pendingConfirmation)) return true;
  if (await handlePendingChannelHistoryReply(message, prompt, context)) return true;
  const fallbackRoute = routeNaturalLanguageCommand(routedContent, prefix);
  if (fallbackRoute && (await handleNaturalLanguageRoute(message, fallbackRoute, context, commands, confirmations))) {
    return true;
  }
  await context.aiChat.handlePrompt(message, prompt);
  return true;
}

function parseAiChannelPrompt(message: Message, context: BotContext, prefix: string): string | null {
  if (!message.guildId || message.author.bot) return null;
  if (context.voiceSettings.getAiChannelId(message.guildId) !== message.channelId) return null;

  const trimmed = message.content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(prefix)) return null;
  return trimmed;
}


function tarotSessionKeyFor(message: Message): TarotSessionKey | null {
  if (!message.guildId) return null;
  return { guildId: message.guildId, channelId: message.channelId, userId: message.author.id };
}

function tarotPendingFor(message: Message, context: BotContext): { topic: string; spreadCount: number; spreadName?: string; expiresAt?: number; requesterDisplayName?: string } | undefined {
  const key = tarotSessionKeyFor(message);
  if (!key || !context.tarotSessions) return undefined;
  const session = context.tarotSessions.get(key, message.createdTimestamp);
  if (!session) return undefined;
  return {
    topic: session.topic,
    spreadCount: session.spreadCount,
    ...(session.spreadName ? { spreadName: session.spreadName } : {}),
    expiresAt: session.expiresAt,
    ...(session.requesterDisplayName ? { requesterDisplayName: session.requesterDisplayName } : {})
  };
}


function rememberTarotClarifySession(message: Message, context: BotContext, outcome: Extract<AgentRuntimeOutcome, { kind: 'clarify' }>): void {
  const pending = outcome.pendingAction;
  const key = tarotSessionKeyFor(message);
  if (!key || !context.tarotSessions || pending?.kind !== 'tarot') return;
  if (!pending.topic || !pending.spreadCount || !pending.missing.includes('numbers')) return;
  if (context.tarotSessions.get(key, message.createdTimestamp)) return;
  context.tarotSessions.start(key, {
    topic: pending.topic,
    spreadCount: pending.spreadCount,
    ...(pending.spreadName ? { spreadName: pending.spreadName } : {}),
    requesterDisplayName: requesterDisplayName(message)
  }, message.createdTimestamp);
}

function hasOnlyCardNumberSelectionSyntax(content: string): boolean {
  const trimmed = content.trim();
  return Boolean(trimmed) && /[0-9]/.test(trimmed) && /^[0-9\s,，、.]+$/.test(trimmed);
}

async function handleActiveTarotSessionReply(
  message: Message,
  prefix: string,
  commands: Collection<string, PrefixCommand>,
  context: BotContext,
  confirmations: ConfirmationManager
): Promise<boolean> {
  if (!message.guildId || message.author.bot || !context.tarotSessions) return false;
  if (!hasOnlyCardNumberSelectionSyntax(message.content)) return false;
  const ownKey = tarotSessionKeyFor(message);
  if (!ownKey) return false;
  const ownSession = context.tarotSessions.get(ownKey, message.createdTimestamp);
  if (ownSession) {
    return handleAiPrompt(message, message.content.trim(), prefix, `${prefix}? ${message.content.trim()}`, commands, context, confirmations);
  }
  const active = context.tarotSessions.getActiveInChannel(message.guildId, message.channelId, message.createdTimestamp);
  if (!active) return false;
  const name = active.session.requesterDisplayName ?? '다른 사용자';
  await message.reply({
    content: `지금은 ${name}님의 타로 카드 선택을 기다리고 있어요. 잠시 뒤에 다시 요청해 주세요.`,
    allowedMentions: { parse: [], repliedUser: false }
  });
  return true;
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
      return handleAiPrompt(message, aiPrompt, prefix, message.content, commands, context, confirmations);
    }
    if (await handleActiveTarotSessionReply(message, prefix, commands, context, confirmations)) return true;
    const routed = routeNaturalLanguageCommand(message.content, prefix);
    if (routed && (await handleNaturalLanguageRoute(message, routed, context, commands, confirmations))) {
      return true;
    }
    const aiChannelPrompt = parseAiChannelPrompt(message, context, prefix);
    if (aiChannelPrompt) {
      return handleAiPrompt(message, aiChannelPrompt, prefix, `${prefix}? ${aiChannelPrompt}`, commands, context, confirmations);
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

function uniqueCommandDefinitions(commands: Collection<string, PrefixCommand>): Array<{ name: string; aliases: readonly string[]; description: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; aliases: readonly string[]; description: string }> = [];
  for (const command of commands.values()) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    result.push({ name: command.name, aliases: command.aliases, description: command.description });
  }
  return result;
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
  const agentTurnContextStore = new AgentTurnContextStore();
  const tarotSessions = new TarotSessionStore();
  const webSearchProvider = createWebSearchProvider(settings);
  const agentRuntime = new AgentRuntime(
    ai,
    createDefaultToolRegistry({
      historySearch: (input, executionContext) =>
        executeHistorySearchTool(executionContext.message as Message, executionContext.botContext as BotContext, input),
      webSearch: (input) => webSearchProvider.search(input),
      voiceJoin: executeVoiceJoinTool,
      voiceLeave: executeVoiceLeaveTool,
      voiceStop: executeVoiceStopTool,
      voiceSpeak: executeVoiceSpeakTool,
      ttsVoicePreset: executeTtsVoicePresetTool,
      ttsEngine: executeTtsEngineTool,
      userTimezone: executeUserTimezoneTool,
      tarotStartReading: executeTarotStartReadingTool,
      tarotRevealSelection: executeTarotRevealSelectionTool
    }),
    agentTurnContextStore
  );
  const confirmations = new ConfirmationManager();
  const voice = new VoiceService(
    new TtsService(settings.ttsVoice, settings.ttsMaxChars),
    voiceSettings,
    settings.ttsVoicePresets,
    settings.ttsEngine as 'edge' | 'gtts',
    settings.voiceIdleLeaveMs
  );
  const context: BotContext = {
    settings,
    usageStore,
    ai,
    aiChat: new AiChatService(settings, ai, memoryStore, activityLog, voiceSettings, (message) => aiChatRuntimeContextFor(context, message)),
    aiCommandPlanner,
    agentRuntime,
    agentTurnContextStore,
    tarotSessions,
    webSearchProvider,
    activityLog,
    voiceSettings,
    voice
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
