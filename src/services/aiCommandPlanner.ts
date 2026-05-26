import type { Collection, Message } from 'discord.js';
import type { AiDetailedResponse, AiService } from './aiService.js';
import type { PrefixCommand } from '../types.js';

const MAX_COMMANDS = 20;
const MAX_ALIASES = 5;
const MAX_COMMAND_LINE_CHARS = 120;
const MAX_CHANNELS = 25;
const MAX_CHANNEL_LINE_CHARS = 80;
const MAX_PLANNER_PROMPT_CHARS = 1500;
const MAX_CONVERSATION_CONTEXT_CHARS = 1200;
const MAX_SYSTEM_PROMPT_CHARS = 6000;
const MAX_RETRIES = 1;

export type AiCommandPlan =
  | { kind: 'chat' }
  | { kind: 'command'; query: string }
  | { kind: 'confirm_pending' }
  | { kind: 'channel-history'; mode: 'summary' | 'qa'; targetChannelReference: string; query: string }
  | { kind: 'time'; target: 'viewer' | 'zone'; offsetSeconds?: number; timeZone?: string; label?: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'unavailable'; message: string };

export type AiCommandPlannerOptions = {
  prefix: string;
  commands: Collection<string, PrefixCommand>;
  availableChannels: readonly { id: string; name: string; mention: string }[];
  userVoiceChannel?: { id: string; name?: string | null } | null;
  botVoiceConnected?: boolean;
  botVoiceChannel?: { id: string; name?: string | null } | null;
  maxCompletionTokens?: number;
  pendingHistory?: { mode: 'summary' | 'qa'; query: string } | null;
  pendingConfirmation?: { preview: string; commandQuery: string; intent: string; normalizedArgs: string } | null;
  conversationContext?: string;
  onDiagnostic?: (details: AiPlannerDiagnostic) => Promise<void> | void;
};

export type AiPlannerDiagnostic = {
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
};

export type PlannerPromptMessages = { role: 'system' | 'user'; content: string }[];

export class AiCommandPlanner {
  constructor(private readonly ai: Pick<AiService, 'askMessages'> & Partial<Pick<AiService, 'askMessagesDetailed'>>) {}

  async plan(message: Message, prompt: string, options: AiCommandPlannerOptions): Promise<AiCommandPlan> {
    if (!message.guildId) return { kind: 'chat' };

    let validationFeedback: string | null = null;
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const messages = buildPlannerMessages(message, prompt, options, validationFeedback);
      await options.onDiagnostic?.({
        event: attempt === 0 ? 'request' : 'retry',
        retryCount: attempt,
        promptSnippet: [`사용자 요청: ${prompt}`, ...messages.map((item) => item.content)].join('\n').slice(0, 500)
      });
      let detailed: string | AiDetailedResponse;
      try {
        detailed = await this.askDetailedOrText({
          guildId: message.guildId,
          userId: message.author.id,
          usageScope: 'planner',
          maxCompletionTokens: options.maxCompletionTokens,
          messages
        });
      } catch (error) {
        const event = isRateLimitError(error) ? 'rate_limit' : 'error';
        await options.onDiagnostic?.({ event, retryCount: attempt, error });
        throw error;
      }

      const response = typeof detailed === 'string' ? detailed : detailed.content;
      await options.onDiagnostic?.({
        event: 'response',
        retryCount: attempt,
        responseSnippet: response.slice(0, 500),
        ...(typeof detailed === 'string' ? {} : toDiagnosticUsage(detailed))
      });
      const parsed = parseAiCommandPlan(response);
      if (parsed.ok) {
        await options.onDiagnostic?.({ event: 'decision', retryCount: attempt, decisionKind: parsed.plan.kind, responseSnippet: response.slice(0, 500) });
        return parsed.plan;
      }

      lastErrors = parsed.errors;
      await options.onDiagnostic?.({ event: 'parse_error', retryCount: attempt, validationErrors: parsed.errors, responseSnippet: response.slice(0, 500) });
      validationFeedback = [
        '이전 응답은 사용할 수 없어요.',
        `오류: ${parsed.errors.join('; ')}`,
        '허용된 JSON 형식 중 하나로만 다시 답하세요.'
      ].join('\n');
    }

    await options.onDiagnostic?.({ event: 'decision', retryCount: MAX_RETRIES, decisionKind: 'chat', validationErrors: lastErrors });
    return { kind: 'chat' };
  }

  private async askDetailedOrText(params: Parameters<AiService['askMessages']>[0]): Promise<string | AiDetailedResponse> {
    if (typeof this.ai.askMessagesDetailed === 'function') {
      return this.ai.askMessagesDetailed(params);
    }
    return this.ai.askMessages(params);
  }
}

function toDiagnosticUsage(detailed: AiDetailedResponse): Pick<
  AiPlannerDiagnostic,
  'model' | 'usageScope' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'rateLimitHeaders' | 'status'
> {
  return {
    model: detailed.model,
    usageScope: detailed.usageScope,
    promptTokens: detailed.promptTokens,
    completionTokens: detailed.completionTokens,
    totalTokens: detailed.totalTokens,
    rateLimitHeaders: detailed.rateLimitHeaders,
    status: detailed.status
  };
}

export function buildPlannerMessages(message: Message, prompt: string, options: AiCommandPlannerOptions, validationFeedback?: string | null): PlannerPromptMessages {
  const promptSections = buildPlannerPromptSections(message, options, validationFeedback);
  const systemPrompt = truncate(promptSections.join('\n'), MAX_SYSTEM_PROMPT_CHARS);

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: truncate(prompt, MAX_PLANNER_PROMPT_CHARS) }
  ];
}

function buildPlannerPromptSections(message: Message, options: AiCommandPlannerOptions, validationFeedback?: string | null): string[] {
  const sections = [
    buildPlannerCoreSection(),
    buildPlannerOutputSection(),
    buildPlannerContextSection(message, options),
    options.pendingConfirmation ? buildPendingConfirmationSection(options.pendingConfirmation) : undefined,
    buildCapabilityCardsSection(options),
    validationFeedback ? `재시도 지시:\n${validationFeedback}` : undefined
  ];
  return sections.filter((section): section is string => Boolean(section));
}

function buildPlannerCoreSection(): string {
  return [
    '너는 Discord 봇 초코코봇의 안전한 AI 명령 라우터예요.',
    '사용자 메시지는 기본적으로 AI 채팅이에요. 실행/조회 의도와 조건이 명확할 때만 command, channel-history, time, confirm_pending을 선택해요.',
    '대기 중인 확인 작업이 없으면 confirm_pending을 쓰지 마세요. 애매하면 clarify, 실행할 수 없으면 unavailable을 선택해요.',
    '출력은 반드시 JSON 객체 하나만 쓰세요. 마크다운, 설명 문장, 코드펜스는 쓰지 마세요.',
    '말투는 짧고 공손한 한국어로 해요. 한국어 응답에서 봇 이름을 말할 때는 초코코봇이라고 써요. 필요할 때만 ...를 쓰고 이모지는 쓰지 않아요.'
  ].join('\n');
}

function buildPlannerOutputSection(): string {
  return [
    '허용 출력 형식:',
    '{"kind":"chat"}',
    '{"kind":"command","query":"도움말"}',
    '{"kind":"confirm_pending"}',
    '{"kind":"channel-history","mode":"summary|qa","targetChannelReference":"<#1234567890>|정확한 채널명|서버 전체","query":"요청 내용"}',
    '{"kind":"time","target":"viewer","offsetSeconds":0}',
    '{"kind":"time","target":"zone","timeZone":"Europe/Budapest","label":"헝가리","offsetSeconds":0}',
    '{"kind":"clarify","message":"어느 채널을 말하는 건가요..."}',
    '{"kind":"unavailable","message":"음성으로 말하려면 먼저 음성 채널에 들어가 있어야 해요..."}'
  ].join('\n');
}

function buildPlannerContextSection(message: Message, options: AiCommandPlannerOptions): string {
  const userVoice = options.userVoiceChannel
    ? `<#${options.userVoiceChannel.id}>${options.userVoiceChannel.name ? ` (${options.userVoiceChannel.name})` : ''}`
    : '(사용자가 음성 채널에 없음)';
  const botVoice = options.botVoiceConnected
    ? `연결됨${options.botVoiceChannel ? `: <#${options.botVoiceChannel.id}>${options.botVoiceChannel.name ? ` (${options.botVoiceChannel.name})` : ''}` : ''}`
    : '연결 안 됨';
  const createdTimestamp = Number.isFinite(message.createdTimestamp) ? message.createdTimestamp : Date.now();
  return [
    '현재 실행 문맥:',
    `현재 채널: <#${message.channelId}>`,
    `현재 프리픽스: ${options.prefix}`,
    `현재 사용자 메시지 작성 시각: <t:${Math.floor(createdTimestamp / 1000)}:t>`,
    `사용자 음성 채널: ${userVoice}`,
    `봇 실제 음성 연결 상태: ${botVoice}`,
    '사용자 음성 채널은 봇의 위치가 아니며, 봇 실제 음성 연결 상태가 연결 안 됨이면 봇이 음성 채널에 있다고 말하지 마세요.',
    options.pendingHistory ? `이전 채널 기록 요청: mode=${options.pendingHistory.mode}, query=${options.pendingHistory.query}` : undefined,
    options.conversationContext ? `최근 대화 기억:\n${truncate(options.conversationContext, MAX_CONVERSATION_CONTEXT_CHARS)}` : undefined
  ].filter(Boolean).join('\n');
}

function buildPendingConfirmationSection(pendingConfirmation: NonNullable<AiCommandPlannerOptions['pendingConfirmation']>): string {
  return [
    '확인 대기 기능:',
    '대기 중인 확인 작업이 실제로 있고 사용자가 그 작업을 승인한다는 의미로 답하면 confirm_pending을 선택해요.',
    '짧은 긍정 답변(예: ㅇ, ㅇㅇ, 응, 네, ok)도 맥락상 승인으로 명확하면 confirm_pending이에요.',
    `대기 중인 확인 작업 JSON: ${JSON.stringify(pendingConfirmation)}`
  ].join('\n');
}

function buildCapabilityCardsSection(options: AiCommandPlannerOptions): string {
  return [
    '기능 판단 카드:',
    '- time: 현재 시간/내 시간/몇시/상대 시간/지역 시간은 time. 지역명은 IANA timeZone으로 변환. viewer는 보는 사람 로컬 표시, zone은 특정 지역.',
    '- channel-history: 서버/채널 대화 요약은 mode=summary, 특정 주제/단어/언급/사건 검색은 mode=qa. 채널 미지정 전체 흐름은 targetChannelReference="서버 전체".',
    '- channel-history targetChannelReference는 아래 참조 가능한 텍스트 채널 mention/정확한 이름 또는 "서버 전체"만 사용. 없는 채널명은 만들지 말고 clarify.',
    '- voice/tts: 음성채널/TTS/읽어줘처럼 음성 의도가 명확할 때만 command. 사용자가 음성 채널에 없으면 unavailable.',
    '- command: 삭제, 프리픽스 변경, 기억 삭제, TTS 채널 변경, AI 채팅 채널 변경은 query만 만들고 확인/권한/실행은 코드가 처리.',
    '- cleanup: 대상 생략 시 본인 메시지라고 단정하지 말고 clarify. 청소는 요청자 본인 메시지가 명확할 때만, 대청소는 채널 전체 삭제가 명확할 때만 query.',
    '지원 명령:',
    formatCommandCatalog(options.commands) || '(없음)',
    '참조 가능한 텍스트 채널:',
    formatChannelCatalog(options.availableChannels) || '(없음)'
  ].join('\n');
}

export function formatCommandCatalog(commands: Collection<string, PrefixCommand>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const command of commands.values()) {
    if (command.aiVisible === false || seen.has(command.name)) continue;
    seen.add(command.name);
    const aliases = command.aliases.filter((alias) => alias.toLowerCase() !== command.name.toLowerCase()).slice(0, MAX_ALIASES);
    const name = [command.name, ...aliases].join(' / ');
    lines.push(truncate(`- ${name} — ${command.description}`, MAX_COMMAND_LINE_CHARS));
    if (lines.length >= MAX_COMMANDS) break;
  }
  return lines.join('\n');
}

export function formatChannelCatalog(channels: readonly { id: string; name: string; mention: string }[]): string {
  return channels.slice(0, MAX_CHANNELS).map((channel) => truncate(`- ${channel.mention} (${channel.name}, id=${channel.id})`, MAX_CHANNEL_LINE_CHARS)).join('\n');
}

export function plannerLimits() {
  return {
    maxCommands: MAX_COMMANDS,
    maxAliases: MAX_ALIASES,
    maxCommandLineChars: MAX_COMMAND_LINE_CHARS,
    maxChannels: MAX_CHANNELS,
    maxChannelLineChars: MAX_CHANNEL_LINE_CHARS,
    maxPlannerPromptChars: MAX_PLANNER_PROMPT_CHARS,
    maxSystemPromptChars: MAX_SYSTEM_PROMPT_CHARS
  };
}

type ParseResult = { ok: true; plan: AiCommandPlan } | { ok: false; errors: string[] };

export function parseAiCommandPlan(response: string): ParseResult {
  const payload = extractJsonPayload(response);
  if (!payload) return { ok: false, errors: ['JSON object not found'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return { ok: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!isRecord(parsed)) return { ok: false, errors: ['Plan must be a JSON object'] };
  const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
  switch (kind) {
    case 'chat':
      return { ok: true, plan: { kind: 'chat' } };
    case 'command': {
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
      if (!query) return { ok: false, errors: ['command.query must be a non-empty string'] };
      return { ok: true, plan: { kind: 'command', query } };
    }
    case 'confirm_pending':
      return { ok: true, plan: { kind: 'confirm_pending' } };
    case 'channel-history': {
      const mode = parsed.mode === 'qa' || parsed.mode === 'summary' ? parsed.mode : null;
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
      const targetChannelReference = typeof parsed.targetChannelReference === 'string' ? parsed.targetChannelReference.trim() : '';
      const errors = [];
      if (!mode) errors.push('channel-history.mode must be summary or qa');
      if (!query) errors.push('channel-history.query must be non-empty');
      if (!targetChannelReference) errors.push('channel-history.targetChannelReference must be non-empty');
      if (errors.length || !mode) return { ok: false, errors };
      return { ok: true, plan: { kind: 'channel-history', mode, query, targetChannelReference } };
    }
    case 'time': {
      const target = parsed.target === 'viewer' || parsed.target === 'zone' ? parsed.target : null;
      const offsetSeconds = parsed.offsetSeconds === undefined ? 0 : Number(parsed.offsetSeconds);
      const timeZone = typeof parsed.timeZone === 'string' ? parsed.timeZone.trim() : undefined;
      const label = typeof parsed.label === 'string' ? parsed.label.trim() : undefined;
      const errors = [];
      if (!target) errors.push('time.target must be viewer or zone');
      if (!Number.isInteger(offsetSeconds)) errors.push('time.offsetSeconds must be an integer');
      if (Number.isFinite(offsetSeconds) && Math.abs(offsetSeconds) > 366 * 24 * 60 * 60) errors.push('time.offsetSeconds is too large');
      if (target === 'zone') {
        if (!timeZone) {
          errors.push('time.timeZone is required when target is zone');
        } else if (!isValidTimeZone(timeZone)) {
          errors.push('time.timeZone must be a valid IANA time zone');
        }
      }
      if (errors.length || !target || !Number.isInteger(offsetSeconds)) return { ok: false, errors };
      return { ok: true, plan: { kind: 'time', target, offsetSeconds, timeZone, label } };
    }
    case 'clarify':
    case 'unavailable': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) return { ok: false, errors: [`${kind}.message must be a non-empty string`] };
      return { ok: true, plan: { kind, message } };
    }
    default:
      return { ok: false, errors: [`Unknown kind: ${kind || '(missing)'}`] };
  }
}

function extractJsonPayload(response: string): string | null {
  const trimmed = response.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function isRateLimitError(error: unknown): boolean {
  return isRecord(error) && error.status === 429;
}
