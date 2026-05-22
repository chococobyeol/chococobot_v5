import type { Collection } from 'discord.js';
import type { ConfirmationIntent } from './confirmationManager.js';
import type { PrefixCommand } from '../types.js';

export type CommandSafetyLevel = 'safe' | 'needs-confirmation' | 'destructive' | 'voice-precondition' | 'unknown';

export type CommandSafety = {
  level: CommandSafetyLevel;
  intent?: ConfirmationIntent;
  reason: string;
  normalizedQuery: string;
  commandName?: string;
  args: string[];
};

const HELP = ['도움말', 'help', 'commands', '명령어', 'command', 'cmd'];
const JOIN = ['들어와', 'join', 'tts-join', '이리와', 'come', '여기와'];
const LEAVE = ['나가', 'leave', 'tts-leave', '꺼져', '저리가', 'go', 'out', '퇴장'];
const STOP = ['멈춰', 'stop', 'halt', 'cancel', 'pause', '정지', '그만', '멈춤', '스톱'];
const SPEAK = ['말', '말해', 'say', 'tts-say', 'speak', 'talk', 'read', 'tts'];
const VOICE = ['음색', 'voice', 'tts-voice', '목소리', 'voice-style', 'voicepreset'];
const ENGINE = ['tts엔진', 'tts-engine', 'engine', '엔진', 'ttsengine'];
const PREFIX = ['프리픽스', 'prefix', 'command-prefix', 'prefixes'];
const MEMORY = ['기억삭제', 'ai-memory', 'ai-reset-memory', 'memory-reset', 'memory-clear', '메모리삭제', '기억초기화'];
const WATCH = ['tts채널', 'tts-channel', 'tts-watch', 'watch', '채널tts'];
const CLEAN_MINE = ['청소', 'clean', 'clean-mine', 'clear', '내청소'];
const CLEAN_ALL = ['대청소', 'clean-all', 'purge', 'bulk-clear'];

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function inList(name: string | undefined, list: readonly string[]): boolean {
  if (!name) return false;
  return list.some((item) => normalizeName(item) === name);
}

export function parseCommandQuery(query: string): { name?: string; args: string[]; normalizedQuery: string } {
  const normalizedQuery = query.trim().replace(/^[!?.~]\s*/, '');
  if (!normalizedQuery) return { args: [], normalizedQuery };
  const [rawName, ...args] = normalizedQuery.split(/\s+/);
  return { name: normalizeName(rawName ?? ''), args, normalizedQuery };
}

export function classifyCommandQuery(query: string, commands?: Collection<string, PrefixCommand>): CommandSafety {
  const parsed = parseCommandQuery(query);
  const knownByRegistry = parsed.name ? commands?.has(parsed.name) : false;
  const base = {
    normalizedQuery: parsed.normalizedQuery,
    commandName: parsed.name,
    args: parsed.args
  };

  if (!parsed.name) return { ...base, level: 'unknown', reason: 'empty command query' };
  if (inList(parsed.name, HELP)) return { ...base, level: 'safe', reason: 'read-only help command' };
  if (inList(parsed.name, JOIN)) return { ...base, level: 'voice-precondition', reason: 'joins the user voice channel' };
  if (inList(parsed.name, LEAVE)) return { ...base, level: 'safe', reason: 'disconnects bot voice connection only' };
  if (inList(parsed.name, STOP)) return { ...base, level: 'safe', reason: 'stops bot playback only' };
  if (inList(parsed.name, SPEAK)) return { ...base, level: 'voice-precondition', reason: 'plays TTS in voice channel' };
  if (inList(parsed.name, VOICE)) return { ...base, level: 'safe', reason: 'user TTS voice setting' };
  if (inList(parsed.name, ENGINE)) return { ...base, level: 'safe', reason: 'user TTS engine setting' };
  if (inList(parsed.name, PREFIX)) {
    const first = parsed.args[0]?.toLowerCase();
    if (!first || ['현재', 'status', 'show', 'info', '조회'].includes(first)) {
      return { ...base, level: 'safe', reason: 'read current command prefix' };
    }
    return { ...base, level: 'needs-confirmation', intent: 'prefix-change', reason: 'changes command prefix' };
  }
  if (inList(parsed.name, MEMORY)) return { ...base, level: 'destructive', intent: 'memory-reset', reason: 'resets AI memory' };
  if (inList(parsed.name, WATCH)) return { ...base, level: 'needs-confirmation', intent: 'watch-channel', reason: 'changes watched TTS channel' };
  if (inList(parsed.name, CLEAN_MINE)) return { ...base, level: 'needs-confirmation', intent: 'cleanup', reason: 'deletes user messages' };
  if (inList(parsed.name, CLEAN_ALL)) return { ...base, level: 'destructive', intent: 'cleanup', reason: 'deletes channel messages' };

  if (knownByRegistry) return { ...base, level: 'safe', reason: 'registered command without special planner safety rule' };
  return { ...base, level: 'unknown', reason: 'unknown command' };
}

export function needsUserVoiceChannel(safety: CommandSafety): boolean {
  return safety.level === 'voice-precondition';
}

export function buildUnavailableVoiceMessage(): string {
  return '음성으로 말하려면 먼저 음성 채널에 들어가 있어야 해요...';
}
