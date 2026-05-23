import type { Collection, Message } from 'discord.js';
import type { AiDetailedResponse, AiService } from './aiService.js';
import type { PrefixCommand } from '../types.js';

const MAX_COMMANDS = 20;
const MAX_ALIASES = 5;
const MAX_COMMAND_LINE_CHARS = 120;
const MAX_CHANNELS = 25;
const MAX_CHANNEL_LINE_CHARS = 80;
const MAX_PLANNER_PROMPT_CHARS = 1500;
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
  maxCompletionTokens?: number;
  pendingHistory?: { mode: 'summary' | 'qa'; query: string } | null;
  pendingConfirmation?: { preview: string; commandQuery: string; intent: string; normalizedArgs: string } | null;
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
  const catalog = formatCommandCatalog(options.commands);
  const channels = formatChannelCatalog(options.availableChannels);
  const userVoice = options.userVoiceChannel
    ? `<#${options.userVoiceChannel.id}>${options.userVoiceChannel.name ? ` (${options.userVoiceChannel.name})` : ''}`
    : '(사용자가 음성 채널에 없음)';
  const systemPrompt = truncate(
    [
      '너는 Discord 봇 ChococoBot의 안전한 AI 명령 라우터예요.',
      '사용자 메시지는 기본적으로 AI 채팅이에요. 명령 실행 의도가 명확하고 조건이 충분할 때만 command를 선택해요.',
      '대기 중인 확인 작업이 있고 사용자가 그 작업을 승인한다는 의미로 답하면 confirm_pending을 선택해요. 승인이 아니면 confirm_pending을 쓰지 마세요.',
      '애매하면 clarify로 구체적인 선택지를 물어봐요. 실행할 수 없는 조건이면 unavailable로 자연스럽게 안내해요.',
      '출력은 반드시 JSON 하나만 쓰세요. 마크다운, 설명 문장, 코드펜스는 쓰지 마세요.',
      '허용 출력 형식:',
      '{"kind":"chat"}',
      '{"kind":"command","query":"도움말"}',
      '{"kind":"confirm_pending"}',
      '{"kind":"clarify","message":"채팅으로 답할까요, 음성으로 말할까요?"}',
      '{"kind":"unavailable","message":"음성으로 말하려면 먼저 음성 채널에 들어가 있어야 해요..."}',
      '{"kind":"channel-history","mode":"summary","targetChannelReference":"<#1234567890>","query":"메모 채널 내용 요약해줘"}',
      '{"kind":"time","target":"viewer","offsetSeconds":0}',
      '{"kind":"time","target":"viewer","offsetSeconds":18000}',
      '{"kind":"time","target":"zone","timeZone":"Europe/Budapest","label":"헝가리","offsetSeconds":0}',
      '현재 시간, 내 시간, 몇시, 몇분, 몇 시간 뒤/후, 특정 지역 시간 질문은 chat이 아니라 time을 선택해요.',
      'target=viewer는 Discord가 보는 사람 로컬 시간으로 보여줘야 할 때 사용해요. target=zone은 헝가리/뉴욕처럼 특정 지역 시간이 명시된 경우 IANA timeZone을 넣어요.',
      'offsetSeconds는 현재 사용자 메시지 작성 시각으로부터 더할 초 단위 정수예요. 예: 5시간 후=18000, 30분 뒤=1800, 지금=0.',
      '지역명은 IANA time zone으로 바꿔요. 예: 헝가리/부다페스트=Europe/Budapest, 뉴욕=America/New_York, LA=America/Los_Angeles, 한국=Asia/Seoul.',
      'channel-history의 targetChannelReference는 반드시 아래 참조 가능한 텍스트 채널 목록의 mention 또는 정확한 이름을 그대로 복사해요. 없는 채널명은 만들지 말고 clarify로 어느 채널인지 물어봐요.',
      '사용자가 서버/채널 대화에서 특정 주제, 단어, 언급, 식당명, 사람, 사건을 찾아보라고 하면 일반 chat이 아니라 channel-history를 선택하고 mode=qa를 사용해요.',
      '채널을 지정하지 않은 "이 서버에 ~ 있는지 찾아봐" 같은 주제 확인은 mode=qa, "최근 무슨 대화 했지"처럼 전체 흐름 요약은 mode=summary로 targetChannelReference를 "서버 전체"로 두고 channel-history를 선택해요.',
      '이전 채널 기록 요청이 있으면 후속 발화도 문맥으로 해석해요. 예: "#배달 여기서 봐줘"는 이전 query를 그 채널에서 다시 검색, "왜 없지? 짬뽕지존은?"은 query를 "짬뽕지존"으로 바꿔 서버 전체에서 다시 검색해요.',
      '말해봐/라고 해봐는 무조건 TTS가 아니에요. 음성채널, TTS, 읽어줘처럼 음성 의도가 명확할 때만 말 명령을 선택해요.',
      '음성 명령인데 사용자가 음성 채널에 없으면 command가 아니라 unavailable을 선택해요.',
      '채팅/메시지 삭제에서 대상이 생략되면 요청자 본인 메시지라고 단정하지 말고 clarify로 누구 채팅인지 물어봐요. 특정 다른 사람 메시지만 지우는 요청은 지원하지 않는다고 안내해요.',
      '삭제, 프리픽스 변경, 기억 삭제, TTS 채널 변경은 명확해도 query만 만들고 실제 확인은 코드가 처리해요. 청소는 요청자 본인 메시지가 명확할 때만, 대청소는 채널 전체 삭제가 명확할 때만 query로 만들어요.',
      '말투는 짧고 공손한 한국어로 해요. 필요할 때만 ...를 써요. 이모지는 쓰지 않아요.',
      '지원 명령:',
      catalog || '(없음)',
      '참조 가능한 텍스트 채널:',
      channels || '(없음)',
      `현재 채널: <#${message.channelId}>`,
      `사용자 음성 채널: ${userVoice}`,
      `봇 음성 연결 상태: ${options.botVoiceConnected ? '연결됨' : '연결 안 됨'}`,
      `현재 프리픽스: ${options.prefix}`,
      `현재 사용자 메시지 작성 시각: <t:${Math.floor(message.createdTimestamp / 1000)}:t>`,
      options.pendingHistory ? `이전 채널 기록 요청: mode=${options.pendingHistory.mode}, query=${options.pendingHistory.query}` : undefined,
      options.pendingConfirmation ? `대기 중인 확인 작업 JSON: ${JSON.stringify(options.pendingConfirmation)}` : undefined,
      validationFeedback ? `재시도 지시:\n${validationFeedback}` : undefined
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_SYSTEM_PROMPT_CHARS
  );

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: truncate(prompt, MAX_PLANNER_PROMPT_CHARS) }
  ];
}

export function formatCommandCatalog(commands: Collection<string, PrefixCommand>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const command of commands.values()) {
    if (seen.has(command.name)) continue;
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
