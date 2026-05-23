import type { Message } from 'discord.js';
import type { AiDetailedResponse, AiService } from './aiService.js';
import { extractErrorDetails, type AiChatMessage } from './aiService.js';
import type { AgentTurnContextStore, AgentTurnStoredContext } from './agentTurnContextStore.js';
import type { AgentToolExecutionContext, AgentToolObservation, AgentToolPolicy, ToolRegistry } from './toolRegistry.js';

const MAX_ITERATIONS = 4;
const MAX_TOTAL_TOOL_CALLS = 8;
const MAX_CALLS_PER_ENVELOPE = 4;
const MAX_RETRIES = 1;
const MAX_PROMPT_CHARS = 1800;
const MAX_OBSERVATION_CHARS = 1400;
const MAX_SYSTEM_CHARS = 9000;

export type AgentRuntimeOutcome =
  | { kind: 'final'; message: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'legacy_command'; query: string }
  | { kind: 'not_handled' };

export type AgentRuntimeDiagnostic = {
  stage: 'agent' | 'tool';
  event: 'request' | 'response' | 'parse_error' | 'retry' | 'decision' | 'error' | 'rate_limit' | 'tool_call' | 'observation' | 'blocked' | 'final' | 'loop_limit';
  runId?: string;
  iteration?: number;
  toolCallId?: string;
  toolName?: string;
  policy?: AgentToolPolicy;
  decisionKind?: string;
  validationErrors?: string[];
  promptSnippet?: string;
  responseSnippet?: string;
  observationSummary?: string;
  model?: string;
  usageScope?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  rateLimitHeaders?: Readonly<Record<string, string>>;
  status?: number;
  error?: unknown;
};

export type AgentRuntimeOptions = {
  prefix: string;
  requesterDisplayName?: string;
  commands: readonly { name: string; aliases: readonly string[]; description: string }[];
  availableChannels: readonly { id: string; name: string; mention: string }[];
  userVoiceChannel?: { id: string; name?: string | null } | null;
  botVoiceConnected?: boolean;
  maxCompletionTokens?: number;
  pendingHistory?: { mode: 'summary' | 'qa'; query: string } | null;
  executionContext: AgentToolExecutionContext;
  onDiagnostic?: (details: AgentRuntimeDiagnostic) => Promise<void> | void;
};

type AgentEnvelope =
  | { kind: 'tool_calls'; calls: AgentToolCall[] }
  | { kind: 'final'; message: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'legacy_command'; query: string }
  | { kind: 'not_handled' };

type AgentToolCall = {
  id: string;
  tool: string;
  input: unknown;
};

type ParseResult = { ok: true; envelope: AgentEnvelope } | { ok: false; errors: string[] };

export class AgentRuntime {
  constructor(
    private readonly ai: Pick<AiService, 'askMessages'> & Partial<Pick<AiService, 'askMessagesDetailed'>>,
    private readonly registry: ToolRegistry,
    private readonly contextStore: AgentTurnContextStore
  ) {}

  async run(message: Message, prompt: string, options: AgentRuntimeOptions): Promise<AgentRuntimeOutcome> {
    if (!message.guildId || message.author.bot) return { kind: 'not_handled' };

    const runId = buildRunId();
    const key = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id };
    const priorContext = this.contextStore.get(key, options.executionContext.nowMs);
    const observations: AgentToolObservation[] = [];
    const toolCalls: AgentToolCall[] = [];
    let validationFeedback: string | null = null;
    let totalToolCalls = 0;
    let blockedOnce = false;
    let actionDecisionRetryRequested = false;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      const messages = this.buildMessages(message, prompt, options, priorContext, observations, validationFeedback);
      await options.onDiagnostic?.({
        stage: 'agent',
        event: validationFeedback ? 'retry' : 'request',
        runId,
        iteration,
        promptSnippet: messages.map((item) => item.content).join('\n').slice(0, 500)
      });

      let detailed: string | AiDetailedResponse;
      try {
        detailed = await this.askDetailedOrText({
          guildId: message.guildId,
          userId: message.author.id,
          usageScope: 'agent',
          maxCompletionTokens: options.maxCompletionTokens,
          messages
        });
      } catch (error) {
        await options.onDiagnostic?.({ stage: 'agent', event: isRateLimitLike(error) ? 'rate_limit' : 'error', runId, iteration, error });
        throw error;
      }

      const response = typeof detailed === 'string' ? detailed : detailed.content;
      await options.onDiagnostic?.({
        stage: 'agent',
        event: 'response',
        runId,
        iteration,
        responseSnippet: response.slice(0, 500),
        ...(typeof detailed === 'string' ? {} : toDiagnosticUsage(detailed))
      });

      const parsed = parseAgentEnvelope(response);
      if (!parsed.ok) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'parse_error', runId, iteration, validationErrors: parsed.errors, responseSnippet: response.slice(0, 500) });
        if (validationFeedback) return { kind: 'not_handled' };
        validationFeedback = ['이전 응답은 사용할 수 없어요.', `오류: ${parsed.errors.join('; ')}`, '허용된 JSON 객체 하나로만 다시 답하세요.'].join('\n');
        continue;
      }

      const envelope = parsed.envelope;
      if (envelope.kind === 'blocked' && shouldRetryLegacyActionDecision(envelope.blockedTools) && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({
          stage: 'agent',
          event: 'retry',
          runId,
          iteration,
          decisionKind: 'legacy_action_decision_required',
          validationErrors: envelope.blockedTools
        });
        actionDecisionRetryRequested = true;
        validationFeedback = buildLegacyActionDecisionFeedback(envelope.blockedTools, options.requesterDisplayName);
        continue;
      }
      if (envelope.kind === 'not_handled' && priorContext?.lastIntent === 'clarify' && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'clarify_follow_up_required' });
        actionDecisionRetryRequested = true;
        validationFeedback = buildClarifyFollowUpFeedback(priorContext);
        continue;
      }
      validationFeedback = null;
      if (envelope.kind === 'legacy_command') {
        const cleanupValidation = validateLegacyCleanupCommand(envelope.query, prompt, priorContext);
        if (!cleanupValidation.ok) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: cleanupValidation.reason });
          if (actionDecisionRetryRequested) {
            return { kind: 'blocked', message: '채팅 삭제 대상이 명확하지 않아 아무 작업도 실행하지 않았어요.', blockedTools: ['command.cleanup'] };
          }
          actionDecisionRetryRequested = true;
          validationFeedback = buildCleanupTargetFeedback(cleanupValidation.reason, priorContext, options.requesterDisplayName);
          continue;
        }
      }
      if (envelope.kind !== 'tool_calls') {
        await options.onDiagnostic?.({ stage: 'agent', event: envelope.kind === 'final' ? 'final' : 'decision', runId, iteration, decisionKind: envelope.kind });
        this.updateTurnContext(key, envelope, prompt, toolCalls, observations, options.executionContext.nowMs);
        return envelope;
      }

      const callErrors = validateToolCallBatch(envelope.calls, this.registry, totalToolCalls);
      if (callErrors.length) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'parse_error', runId, iteration, validationErrors: callErrors });
        if (iteration > MAX_RETRIES) return { kind: 'not_handled' };
        validationFeedback = ['도구 호출을 실행할 수 없어요.', `오류: ${callErrors.join('; ')}`, '도구 호출을 고치거나 final/blocked/clarify로 답하세요.'].join('\n');
        continue;
      }

      const policies = envelope.calls.map((call) => this.registry.get(call.tool)?.policy ?? 'blocked');
      const nonReadOnly = policies.filter((policy) => policy !== 'read_only_auto');
      if (nonReadOnly.length > 0) {
        const blockedTools = envelope.calls.filter((call) => this.registry.get(call.tool)?.policy !== 'read_only_auto').map((call) => call.tool);
        const mixed = policies.some((policy) => policy === 'read_only_auto') && nonReadOnly.length > 0;
        if (!mixed && shouldRetryLegacyActionDecision(blockedTools) && !actionDecisionRetryRequested) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'legacy_action_decision_required', validationErrors: blockedTools });
          actionDecisionRetryRequested = true;
          validationFeedback = buildLegacyActionDecisionFeedback(blockedTools, options.requesterDisplayName);
          continue;
        }
        await options.onDiagnostic?.({ stage: 'agent', event: 'blocked', runId, iteration, decisionKind: mixed ? 'mixed_tool_request' : 'non_auto_tool', validationErrors: blockedTools });
        for (const call of envelope.calls) {
          const policy = this.registry.get(call.tool)?.policy ?? 'blocked';
          observations.push({ callId: call.id, toolName: call.tool, status: 'blocked', policy, error: mixed ? 'Mixed action/read request is blocked; no tools executed.' : `Tool policy ${policy} is not auto-executable.` });
        }
        if (blockedOnce) {
          const messageText = mixed
            ? '읽기 작업과 실행/삭제/설정 작업이 섞인 요청은 자동으로 처리할 수 없어요... 아무 작업도 실행하지 않았어요.'
            : '그 작업은 자동 실행할 수 없어요... 아무 작업도 실행하지 않았어요.';
          return { kind: 'blocked', message: messageText, blockedTools };
        }
        blockedOnce = true;
        if (mixed) actionDecisionRetryRequested = true;
        validationFeedback = ['방금 요청한 도구는 정책상 실행하지 않았고 관찰값으로 blocked를 추가했어요.', '이제 도구 호출 없이 final 또는 blocked JSON으로 사용자에게 짧게 설명하세요.'].join('\n');
        continue;
      }

      for (const call of envelope.calls) {
        await options.onDiagnostic?.({ stage: 'tool', event: 'tool_call', runId, iteration, toolCallId: call.id, toolName: call.tool, policy: this.registry.get(call.tool)?.policy });
        const observation = await this.registry.execute(call.tool, call.input, options.executionContext);
        observation.callId = call.id;
        observations.push(observation);
        toolCalls.push(call);
        totalToolCalls += 1;
        await options.onDiagnostic?.({
          stage: 'tool',
          event: 'observation',
          runId,
          iteration,
          toolCallId: call.id,
          toolName: call.tool,
          policy: observation.policy,
          observationSummary: summarizeObservation(observation)
        });
      }
    }

    await options.onDiagnostic?.({ stage: 'agent', event: 'loop_limit', runId, decisionKind: 'not_handled' });
    return { kind: 'not_handled' };
  }

  private buildMessages(
    message: Message,
    prompt: string,
    options: AgentRuntimeOptions,
    priorContext: AgentTurnStoredContext | undefined,
    observations: readonly AgentToolObservation[],
    validationFeedback: string | null
  ): AiChatMessage[] {
    const userVoice = options.userVoiceChannel
      ? `<#${options.userVoiceChannel.id}>${options.userVoiceChannel.name ? ` (${options.userVoiceChannel.name})` : ''}`
      : '(사용자가 음성 채널에 없음)';
    const system = truncate([
      '너는 Discord 봇 ChococoBot의 bounded agent runtime이에요.',
      '사용자 요청은 현재 프리픽스 뒤에 ?로 들어온 AI 요청이에요.',
      '반드시 JSON 객체 하나만 출력하세요. 마크다운, 코드펜스, 설명 문장은 금지예요.',
      '읽기 전용 도구는 필요한 만큼 여러 번 호출하고, 관찰값을 본 뒤 한국어로 자연스럽게 final을 작성해요.',
      '삭제/설정/관리/음성 말하기 같은 실행 도구는 임의 agent loop에서 자동 실행하지 않아요.',
      '음성 말하기도 단 하나의 명확한 기존 말 명령이면 blocked가 아니라 legacy_command를 쓰세요. 예: {"kind":"legacy_command","query":"말 안녕"}',
      '프리픽스 변경, TTS 채널 설정, 기억삭제처럼 기존 명령이 있는 단일 실행 요청도 blocked가 아니라 legacy_command로 넘기세요.',
      '읽기 요청과 실행/삭제/설정/음성 요청이 섞여 있으면 blocked로 답하고 아무 것도 실행하지 마세요.',
      '채팅/메시지 삭제 요청에서 그냥 "채팅 3개"처럼 대상이 생략되면 요청자 본인 메시지라고 단정하지 말고 clarify로 누구 채팅인지 물어봐요.',
      '요청자가 "내 채팅/내꺼/내 메시지"라고 명확히 말했거나 이전 clarify 후속으로 본인 것이라고 답한 경우에만 {"kind":"legacy_command","query":"청소 N"}를 사용해요.',
      '특정 다른 사람의 메시지만 지우는 요청은 청소로 처리하지 마세요. 봇은 요청자 본인 메시지 청소 또는 관리자용 채널 전체 대청소만 지원해요.',
      '대청소/전체/채널 전체처럼 채널 메시지 삭제가 명확하면 {"kind":"legacy_command","query":"대청소 N"}를 사용하고 기존 관리자/확인 경로에 맡겨요.',
      '채팅/메시지 삭제 요청에 개수나 대상이 부족하면 clarify로 자연스럽게 되물어봐요.',
      '이전 agent 문맥이 clarify이면 현재 짧은 답변(예: 내꺼, 전체, 3개)을 이전 요청과 합쳐 legacy_command/clarify/blocked 중 하나로 처리해요.',
      '일반 대화처럼 도구가 필요 없으면 not_handled를 선택해 기존 AI 채팅으로 넘겨요.',
      '허용 출력:',
      '{"kind":"tool_calls","calls":[{"id":"call_1","tool":"time.in_zone","input":{"timeZone":"America/New_York","label":"동부","offsetSeconds":0}}]}',
      '{"kind":"final","message":"..."}',
      '{"kind":"clarify","message":"..."}',
      '{"kind":"unavailable","message":"..."}',
      '{"kind":"blocked","message":"...","blockedTools":["command.cleanup","voice.speak"]}',
      '{"kind":"legacy_command","query":"말 안녕"}',
      '{"kind":"not_handled"}',
      '미국 시간대 질문은 최소 Eastern/Central/Mountain/Pacific을 각각 time.in_zone으로 호출해요. IANA: America/New_York, America/Chicago, America/Denver, America/Los_Angeles.',
      '이전 맥락이 시간대 목록이면 "그 4군데" 같은 후속 요청에 같은 timeZone 슬롯을 재사용해요.',
      '대화 내용/기록/찾아봐/검색/요약 요청은 history.search를 사용해요. 서버 전체면 scope=server, 채널 지정이면 scope=channel과 channelRef를 넣어요.',
      '도구 목록:',
      this.registry.list().map((tool) => `- ${tool.name} [${tool.policy}] ${tool.description} input=${tool.inputSchema}`).join('\n'),
      '지원 prefix 명령:',
      formatCommands(options.commands),
      '참조 가능한 텍스트 채널:',
      options.availableChannels.map((channel) => `- ${channel.mention} (${channel.name}, id=${channel.id})`).join('\n') || '(없음)',
      `현재 채널: <#${message.channelId}>`,
      options.requesterDisplayName ? `요청자 표시 이름: ${options.requesterDisplayName}` : undefined,
      `사용자 음성 채널: ${userVoice}`,
      `봇 음성 연결 상태: ${options.botVoiceConnected ? '연결됨' : '연결 안 됨'}`,
      `현재 프리픽스: ${options.prefix}`,
      `현재 사용자 메시지 작성 시각: <t:${Math.floor(options.executionContext.nowMs / 1000)}:t>`,
      options.pendingHistory ? `기존 채널 기록 후속 문맥: mode=${options.pendingHistory.mode}, query=${options.pendingHistory.query}` : undefined,
      priorContext ? `이전 agent 문맥 JSON: ${JSON.stringify(priorContext).slice(0, 1200)}` : undefined,
      observations.length ? `도구 관찰 JSON: ${JSON.stringify(observations).slice(0, MAX_OBSERVATION_CHARS)}` : undefined,
      validationFeedback ? `재시도 지시:\n${validationFeedback}` : undefined
    ].filter(Boolean).join('\n'), MAX_SYSTEM_CHARS);

    return [
      { role: 'system', content: system },
      { role: 'user', content: truncate(prompt, MAX_PROMPT_CHARS) }
    ];
  }

  private async askDetailedOrText(params: Parameters<AiService['askMessages']>[0]): Promise<string | AiDetailedResponse> {
    if (typeof this.ai.askMessagesDetailed === 'function') return this.ai.askMessagesDetailed(params);
    return this.ai.askMessages(params);
  }

  private updateTurnContext(
    key: { guildId: string; channelId: string; userId: string },
    envelope: AgentEnvelope,
    prompt: string,
    calls: readonly AgentToolCall[],
    observations: readonly AgentToolObservation[],
    nowMs: number
  ): void {
    if (envelope.kind === 'not_handled' || envelope.kind === 'legacy_command' || (envelope.kind === 'final' && calls.length === 0)) {
      this.contextStore.clear(key);
      return;
    }
    const slots: AgentTurnStoredContext['slots'] = {};
    for (const call of calls) {
      if (call.tool === 'time.in_zone' && isRecord(call.input) && typeof call.input.timeZone === 'string') {
        slots.timeZones = [...(slots.timeZones ?? []), call.input.timeZone];
      }
      if (call.tool === 'history.search' && isRecord(call.input)) {
        if (call.input.scope === 'server' || call.input.scope === 'channel') slots.scope = call.input.scope;
        if (typeof call.input.channelRef === 'string') slots.channelRef = call.input.channelRef;
        if (typeof call.input.query === 'string') slots.topic = call.input.query;
        if (call.input.mode === 'qa' || call.input.mode === 'summary') slots.mode = call.input.mode;
      }
    }
    this.contextStore.set(key, {
      lastIntent: inferIntent(calls, envelope),
      lastUserPrompt: prompt,
      lastAgentMessage: 'message' in envelope ? envelope.message : undefined,
      lastToolCalls: calls.map((call) => ({ tool: call.tool, input: call.input })),
      slots,
      observations: observations.slice(-4).map((observation) => compactObservation(observation))
    }, nowMs);
  }
}




type CleanupValidationResult = { ok: true } | { ok: false; reason: 'cleanup_target_ambiguous' | 'other_user_cleanup_unsupported' };

function validateLegacyCleanupCommand(query: string, prompt: string, priorContext?: AgentTurnStoredContext): CleanupValidationResult {
  const commandName = query.trim().replace(/^[!?.~]\s*/, '').split(/\s+/)[0]?.toLowerCase();
  if (!['청소', 'clean', 'clean-mine', 'clear', '내청소'].includes(commandName ?? '')) return { ok: true };
  const currentText = prompt.toLowerCase();
  if (mentionsOtherUserCleanup(currentText) || mentionsChannelWideCleanup(currentText)) return { ok: false, reason: 'other_user_cleanup_unsupported' };
  if (mentionsRequesterCleanup(currentText)) return { ok: true };

  const priorRequestText = priorContext?.lastUserPrompt?.toLowerCase() ?? '';
  if (priorContext?.lastIntent === 'clarify' && mentionsRequesterCleanup(currentText) && priorRequestText) return { ok: true };
  if (mentionsOtherUserCleanup(priorRequestText) || mentionsChannelWideCleanup(priorRequestText)) return { ok: false, reason: 'other_user_cleanup_unsupported' };
  if (mentionsRequesterCleanup(priorRequestText)) return { ok: true };
  return { ok: false, reason: 'cleanup_target_ambiguous' };
}

function mentionsRequesterCleanup(value: string): boolean {
  return /내\s*(?:가\s*)?(?:채팅|메시지|메세지|글|말)|내꺼|내\s*것|내\s*최근|본인|제\s*(?:채팅|메시지|메세지)|my\s+(?:messages?|chat)/i.test(value);
}

function mentionsChannelWideCleanup(value: string): boolean {
  return /대청소|전체|모든|전부|채널\s*(?:전체)?|서버|다\s*지워|싹|purge|bulk|all/i.test(value);
}

function mentionsOtherUserCleanup(value: string): boolean {
  return /남의|다른\s*사람|타인|걔|쟤|그\s*사람|<@!?\d+>|\b\w+님(?:의)?\s*(?:채팅|메시지|메세지|글|말)/i.test(value);
}

function buildCleanupTargetFeedback(reason: 'cleanup_target_ambiguous' | 'other_user_cleanup_unsupported', priorContext: AgentTurnStoredContext | undefined, displayName?: string): string {
  return [
    reason === 'other_user_cleanup_unsupported'
      ? '방금 legacy_command가 특정 다른 사람 또는 채널 전체 삭제 요청을 청소로 처리하려 했어요. 청소는 요청자 본인 메시지 삭제에만 사용하세요.'
      : '방금 legacy_command가 대상이 불명확한 채팅 삭제 요청을 청소로 처리하려 했어요. 그냥 “채팅 N개”는 요청자 본인 메시지라고 단정하지 마세요.',
    '요청자 본인 메시지인지 명확하지 않으면 clarify JSON으로 누구 채팅을 지울지 자연스럽게 물어보세요.',
    '특정 다른 사람 메시지만 지우는 요청은 지원하지 않으며, 채널 전체 삭제가 명확한 경우에만 대청소 N으로 넘기세요.',
    priorContext?.lastUserPrompt ? `이전 사용자 요청: ${priorContext.lastUserPrompt}` : undefined,
    priorContext?.lastAgentMessage ? `이전 clarify 질문: ${priorContext.lastAgentMessage}` : undefined,
    displayName ? `요청자 표시 이름은 ${displayName}예요.` : undefined
  ].filter(Boolean).join('\n');
}

function buildClarifyFollowUpFeedback(priorContext: AgentTurnStoredContext): string {
  return [
    '현재 사용자 메시지는 이전 clarify 질문에 대한 후속 답변일 수 있어요.',
    priorContext.lastUserPrompt ? `이전 사용자 요청: ${priorContext.lastUserPrompt}` : undefined,
    priorContext.lastAgentMessage ? `이전 clarify 질문: ${priorContext.lastAgentMessage}` : undefined,
    '현재 답변과 이전 요청을 합쳐 명확해졌다면 legacy_command JSON을 작성하세요. 아직 부족하면 clarify JSON으로 추가 질문하세요. 일반 대화가 확실할 때만 not_handled를 쓰세요.'
  ].filter(Boolean).join('\n');
}

function shouldRetryLegacyActionDecision(blockedTools: readonly string[]): boolean {
  return blockedTools.some((tool) => LEGACY_ACTION_TOOL_NAMES.has(tool));
}

const LEGACY_ACTION_TOOL_NAMES = new Set([
  'voice.speak',
  'command.cleanup',
  'command.mass_cleanup',
  'settings.prefix',
  'settings.tts_channel',
  'memory.delete'
]);

function buildLegacyActionDecisionFeedback(blockedTools: readonly string[], displayName?: string): string {
  return [
    `이전 응답은 ${blockedTools.join(', ')}를 blocked/tool_calls로 처리했지만, 기존 prefix 명령으로 넘길 수 있는 단일 실행 요청일 수 있어요.`,
    '사용자 요청을 직접 다시 판단하세요. 명확한 단일 기존 명령이면 legacy_command JSON을 작성하고 query는 지원 prefix 명령 목록의 명령/별칭과 인자를 사용해 직접 생성하세요.',
    '채팅/메시지 삭제에서 대상이 생략되면 요청자 본인 메시지라고 단정하지 마세요. 내 채팅/내꺼가 명확할 때만 청소 N을 사용하고, 그냥 채팅 N개는 clarify로 누구 채팅인지 물어보세요.',
    '특정 다른 사람 메시지만 지우는 요청은 지원하지 않아요. 요청자 본인 청소 또는 관리자용 대청소만 가능하다고 안내하세요.',
    '읽기 요청과 실행 요청이 섞였거나 기존 명령으로 안전하게 표현할 수 없으면 blocked JSON으로 답하세요.',
    '비자동 도구를 tool_calls로 다시 호출하지 마세요.',
    displayName ? `요청자 표시 이름은 ${displayName}예요. 필요하면 clarify 문장에 반영하세요.` : undefined
  ].filter(Boolean).join('\n');
}

function parseAgentEnvelope(response: string): ParseResult {
  const payload = extractJsonPayload(response);
  if (!payload) return { ok: false, errors: ['JSON object not found'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return { ok: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: ['Envelope must be an object'] };
  const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
  switch (kind) {
    case 'tool_calls': {
      if (!Array.isArray(parsed.calls)) return { ok: false, errors: ['tool_calls.calls must be an array'] };
      const calls: AgentToolCall[] = [];
      const errors: string[] = [];
      for (const [index, raw] of parsed.calls.entries()) {
        if (!isRecord(raw)) {
          errors.push(`calls[${index}] must be an object`);
          continue;
        }
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const tool = typeof raw.tool === 'string' ? raw.tool.trim() : '';
        if (!id) errors.push(`calls[${index}].id must be non-empty`);
        if (!tool) errors.push(`calls[${index}].tool must be non-empty`);
        calls.push({ id, tool, input: raw.input ?? {} });
      }
      if (errors.length) return { ok: false, errors };
      return { ok: true, envelope: { kind: 'tool_calls', calls } };
    }
    case 'final':
    case 'clarify':
    case 'unavailable': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) return { ok: false, errors: [`${kind}.message must be non-empty`] };
      return { ok: true, envelope: { kind, message } };
    }
    case 'blocked': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const blockedTools = Array.isArray(parsed.blockedTools) ? parsed.blockedTools.filter((item): item is string => typeof item === 'string') : [];
      if (!message) return { ok: false, errors: ['blocked.message must be non-empty'] };
      return { ok: true, envelope: { kind: 'blocked', message, blockedTools } };
    }
    case 'legacy_command': {
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
      if (!query) return { ok: false, errors: ['legacy_command.query must be non-empty'] };
      return { ok: true, envelope: { kind: 'legacy_command', query } };
    }
    case 'not_handled':
      return { ok: true, envelope: { kind: 'not_handled' } };
    default:
      return { ok: false, errors: [`Unknown kind: ${kind || '(missing)'}`] };
  }
}

function validateToolCallBatch(calls: readonly AgentToolCall[], registry: ToolRegistry, totalToolCalls: number): string[] {
  const errors: string[] = [];
  if (!calls.length) errors.push('tool_calls.calls must contain at least one call');
  if (calls.length > MAX_CALLS_PER_ENVELOPE) errors.push(`too many calls in one envelope; max ${MAX_CALLS_PER_ENVELOPE}`);
  if (totalToolCalls + calls.length > MAX_TOTAL_TOOL_CALLS) errors.push(`too many total tool calls; max ${MAX_TOTAL_TOOL_CALLS}`);
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) errors.push(`duplicate call id ${call.id}`);
    ids.add(call.id);
    if (!registry.get(call.tool)) errors.push(`unknown tool ${call.tool}`);
  }
  return errors;
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

function toDiagnosticUsage(detailed: AiDetailedResponse): Pick<AgentRuntimeDiagnostic, 'model' | 'usageScope' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'rateLimitHeaders' | 'status'> {
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

function summarizeObservation(observation: AgentToolObservation): string {
  const base = {
    callId: observation.callId,
    toolName: observation.toolName,
    status: observation.status,
    policy: observation.policy,
    error: observation.error
  };
  if (!isRecord(observation.output)) return JSON.stringify(base).slice(0, 500);
  if (observation.toolName === 'history.search') {
    return JSON.stringify({
      ...base,
      scope: observation.output.scope,
      channelId: observation.output.channelId,
      query: observation.output.query,
      scannedChannels: observation.output.scannedChannels,
      matchedMessages: observation.output.matchedMessages,
      usedMessages: observation.output.usedMessages,
      evidenceCount: Array.isArray(observation.output.evidence) ? observation.output.evidence.length : undefined
    }).slice(0, 500);
  }
  if (observation.toolName.startsWith('time.')) {
    return JSON.stringify({
      ...base,
      label: observation.output.label,
      timeZone: observation.output.timeZone,
      display: observation.output.display,
      epochSeconds: observation.output.epochSeconds
    }).slice(0, 500);
  }
  return JSON.stringify({ ...base, outputKeys: Object.keys(observation.output).slice(0, 10) }).slice(0, 500);
}

function compactObservation(observation: AgentToolObservation): unknown {
  return {
    callId: observation.callId,
    toolName: observation.toolName,
    status: observation.status,
    policy: observation.policy,
    output: observation.output,
    error: observation.error
  };
}

function inferIntent(calls: readonly AgentToolCall[], envelope: AgentEnvelope): string | undefined {
  if (calls.some((call) => call.tool.startsWith('time.'))) return 'time';
  if (calls.some((call) => call.tool.startsWith('history.'))) return 'history';
  return envelope.kind;
}

function formatCommands(commands: AgentRuntimeOptions['commands']): string {
  return commands
    .slice(0, 20)
    .map((command) => `- ${[command.name, ...command.aliases.slice(0, 5)].join(' / ')} — ${command.description}`.slice(0, 140))
    .join('\n') || '(없음)';
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function buildRunId(): string {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRateLimitLike(error: unknown): boolean {
  return extractErrorDetails(error).status === 429;
}
