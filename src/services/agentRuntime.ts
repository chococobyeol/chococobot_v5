import type { Message } from 'discord.js';
import type { AiDetailedResponse, AiService } from './aiService.js';
import { extractErrorDetails, type AiChatMessage } from './aiService.js';
import type { AgentPendingAction, AgentTurnContextStore, AgentTurnStoredContext } from './agentTurnContextStore.js';
import type { AgentDiscordPresentation, AgentToolDefinition, AgentToolExecutionContext, AgentToolObservation, AgentToolPolicy, ToolRegistry } from './toolRegistry.js';
import type { WebSearchMode, WebSearchProviderName, WebSearchProviderStatus } from './webSearchService.js';

const MAX_ITERATIONS = 4;
const MAX_TOTAL_TOOL_CALLS = 8;
const MAX_CALLS_PER_ENVELOPE = 4;
const MAX_RETRIES = 1;
const MAX_PROMPT_CHARS = 1800;
const MAX_OBSERVATION_CHARS = 1400;
const MAX_CONVERSATION_CONTEXT_CHARS = 1200;
const MAX_SYSTEM_CHARS = 5199;
const MAX_PROMPT_CHANNELS = 16;
const AGENT_OUTPUT_CONTRACT = [
  '너는 Discord 봇 초코코봇의 bounded agent runtime이에요.',
  '반드시 JSON 객체 하나만 출력하세요. 마크다운/코드펜스/설명 문장 금지.',
  'top-level field는 반드시 kind입니다. status/action 같은 다른 top-level decision field를 쓰지 마세요.',
  '허용 kind: tool_calls, final, clarify, unavailable, blocked, confirm_pending, not_handled.',
  'provider/native tool call을 사용하지 마세요. 도구 호출도 JSON 텍스트 {"kind":"tool_calls","calls":[...]}로만 출력하세요.',
  '도구 계약: AI는 의미를 판단해 허용 출력 중 하나를 고르고, 코드는 schema/policy/safety/loop만 검증해요.',
  '도구가 필요하면 tool_calls만 사용하고 도구 상세 목록의 name/policy/input schema를 그대로 따르세요.',
  '도구 관찰값이 있으면 not_handled로 넘기지 말고 관찰값만 근거로 final/unavailable/blocked 중 하나로 마무리해요.',
  'conversation/이전 agent 문맥이 있으면 사용자의 후속 질문을 그 문맥으로 먼저 해석해요.',
  '이미 성공한 같은 입력의 도구는 다시 호출하지 말고 기존 도구 관찰 JSON으로 답해요.',
  '읽기 요청과 실행/삭제/설정/음성 요청이 섞이면 blocked로 답하고 아무 것도 실행하지 마세요.',
  '필수 구조화 필드가 부족하면 clarify+pendingAction을 사용하되, missing에는 사용자가 답할 수 있는 필드만 넣어요.',
  'pendingConfirmation 없으면 confirm_pending 금지. 있으면 명확한 승인일 때만 confirm_pending.',
  '일반 대화처럼 도구가 필요 없으면 not_handled를 선택해 기존 AI 채팅으로 넘겨요. 예: {"kind":"not_handled"}',
  'final 스타일: 한국어 초코코봇 말투, 짧고 자연스럽게 답해요. 봇 이름을 직접 말할 때는 초코코봇이라고 써요. 느낌표/물음표/이모지 금지. 문장 끝에 해요나 ...를 접미어처럼 억지로 덧붙이지 마세요.',
  'outputs={"tool_calls":{"calls":[{"id":"call_1","tool":"registered.tool","input":{}}]},"final":{"message":"..."},"clarify":{"message":"...","pendingAction":{"kind":"cleanup|history|tarot","originalPrompt":"...","missing":["field"]}},"unavailable":{"message":"...","reason":"web_search_unavailable?"},"blocked":{"message":"...","blockedTools":["tool.name"]},"confirm_pending":{},"not_handled":{}}'
].join('\n');

export type AgentRuntimeOutcome =
  | { kind: 'final'; message: string; presentation?: AgentDiscordPresentation }
  | { kind: 'clarify'; message: string; pendingAction?: AgentPendingAction }
  | { kind: 'unavailable'; message: string; reason?: 'web_search_unavailable' }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'confirmation_required'; message: string; intent: string; preview: string; commandQuery: string; payload?: unknown }
  | { kind: 'confirm_pending' }
  | { kind: 'not_handled'; reason?: 'final_without_observation' };

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
  botVoiceChannel?: { id: string; name?: string | null } | null;
  maxCompletionTokens?: number;
  pendingHistory?: { mode: 'summary' | 'qa'; query: string } | null;
  pendingConfirmation?: { preview: string; commandQuery: string; intent: string; normalizedArgs: string } | null;
  conversationContext?: string;
  webSearch?: {
    mode: WebSearchMode;
    provider: WebSearchProviderName;
    providerStatus: WebSearchProviderStatus;
    resultCount: number;
  };
  tarotPending?: { topic: string; spreadCount: number; spreadName?: string; expiresAt?: number; requesterDisplayName?: string } | null;
  executionContext: AgentToolExecutionContext;
  onDiagnostic?: (details: AgentRuntimeDiagnostic) => Promise<void> | void;
};

type AgentEnvelope =
  | { kind: 'tool_calls'; calls: AgentToolCall[] }
  | { kind: 'final'; message: string; presentation?: AgentDiscordPresentation }
  | { kind: 'clarify'; message: string; pendingAction?: AgentPendingAction }
  | { kind: 'unavailable'; message: string; reason?: 'web_search_unavailable' }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'confirm_pending' }
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
    let observationAnswerRetryRequested = false;
    const repeatedSuccessfulToolRetryKeys = new Set<string>();
    let validationFailureFallback: AgentRuntimeOutcome | null = null;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      const messages = this.buildMessages(message, prompt, options, priorContext, observations, validationFeedback);
      await options.onDiagnostic?.({
        stage: 'agent',
        event: validationFeedback ? 'retry' : 'request',
        runId,
        iteration,
        promptSnippet: summarizePromptForDiagnostic(messages)
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
        if (validationFeedback) {
          const fallback = buildObservationBasedFallbackOutcome(observations);
          if (fallback) {
            this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
            return fallback;
          }
          return validationFailureFallback ?? { kind: 'not_handled' };
        }
        validationFeedback = ['이전 응답은 사용할 수 없어요.', `오류: ${parsed.errors.join('; ')}`, '허용된 JSON 객체 하나로만 다시 답하세요.'].join('\n');
        continue;
      }

      const envelope = parsed.envelope;
      if (envelope.kind === 'confirm_pending' && !options.pendingConfirmation) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'spurious_confirm_pending' });
        if (actionDecisionRetryRequested) return { kind: 'not_handled' };
        actionDecisionRetryRequested = true;
        validationFeedback = [
          '현재 대기 중인 확인 작업이 없으므로 confirm_pending은 사용할 수 없어요.',
          '설정/삭제/실행 의도라면 적절한 tool_calls JSON을 쓰고, 일반 대화면 not_handled를 쓰세요.'
        ].join('\n');
        continue;
      }
      if (envelope.kind === 'not_handled' && options.pendingConfirmation && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'pending_confirmation_decision_required' });
        actionDecisionRetryRequested = true;
        validationFeedback = buildPendingConfirmationFeedback(options.pendingConfirmation);
        continue;
      }
      if (envelope.kind === 'not_handled' && (priorContext?.lastIntent === 'clarify' || priorContext?.pendingAction) && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'clarify_follow_up_required' });
        actionDecisionRetryRequested = true;
        validationFailureFallback = buildPendingActionBlockedFallback(priorContext?.pendingAction);
        validationFeedback = buildClarifyFollowUpFeedback(priorContext);
        continue;
      }
      if (envelope.kind === 'not_handled' && priorContext && isReusableFollowUpIntent(priorContext.lastIntent) && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'prior_context_follow_up_required' });
        actionDecisionRetryRequested = true;
        validationFeedback = buildPriorContextFollowUpFeedback(priorContext);
        continue;
      }
      if (envelope.kind === 'not_handled' && priorContext?.pendingAction) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'blocked', runId, iteration, decisionKind: 'pending_action_not_resolved' });
        this.updateTurnContext(key, { kind: 'clarify', message: 'pending action unresolved', pendingAction: priorContext.pendingAction }, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return buildPendingActionBlockedFallback(priorContext.pendingAction);
      }
      validationFeedback = null;
      const webSearchFailure = buildWebSearchFailureOutcome(observations);
      if ((envelope.kind === 'not_handled' || envelope.kind === 'final') && webSearchFailure) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'web_search_unavailable' });
        this.updateTurnContext(key, webSearchFailure, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return webSearchFailure;
      }
      if (isEmptyBlockedDecision(envelope, observations, toolCalls)) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'empty_blocked_decision' });
        if (actionDecisionRetryRequested) return { kind: 'not_handled', reason: 'final_without_observation' };
        actionDecisionRetryRequested = true;
        validationFeedback = buildEmptyBlockedFeedback();
        continue;
      }
      if (envelope.kind === 'not_handled' && hasUsableObservation(observations)) {
        const fallback = buildObservationBasedFallbackOutcome(observations);
        if (observationAnswerRetryRequested) {
          if (fallback) {
            await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'observation_based_final' });
            this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
            return fallback;
          }
          return { kind: 'not_handled' };
        }
        await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'observation_answer_required' });
        observationAnswerRetryRequested = true;
        validationFeedback = buildObservationAnswerRequiredFeedback(observations);
        continue;
      }
      if (envelope.kind !== 'tool_calls') {
        const hasConversationContext = Boolean(options.conversationContext?.trim());
        if (envelope.kind === 'final' && toolCalls.length === 0 && observations.length === 0 && !priorContext && !hasConversationContext) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'final_without_observation' });
          return { kind: 'not_handled', reason: 'final_without_observation' };
        }
        await options.onDiagnostic?.({ stage: 'agent', event: envelope.kind === 'final' ? 'final' : 'decision', runId, iteration, decisionKind: envelope.kind });
        const outcome = withTrustedPresentation(envelope, observations);
        this.updateTurnContext(key, outcome, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return outcome;
      }

      const callErrors = validateToolCallBatch(envelope.calls, this.registry, totalToolCalls);
      if (callErrors.length) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'parse_error', runId, iteration, validationErrors: callErrors });
        if (iteration > MAX_RETRIES) {
          const fallback = buildObservationBasedFallbackOutcome(observations);
          if (fallback) {
            this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
            return fallback;
          }
          return { kind: 'not_handled' };
        }
        validationFeedback = ['도구 호출을 실행할 수 없어요.', `오류: ${callErrors.join('; ')}`, '도구 호출을 고치거나 final/blocked/clarify로 답하세요.'].join('\n');
        continue;
      }

      const unsafeCallObservations = validateToolCallSafety(envelope.calls, prompt, priorContext);
      if (unsafeCallObservations.length) {
        await options.onDiagnostic?.({
          stage: 'agent',
          event: 'parse_error',
          runId,
          iteration,
          validationErrors: unsafeCallObservations.map((observation) => observation.message ?? 'tool safety validation failed')
        });
        observations.push(...unsafeCallObservations);
        if (actionDecisionRetryRequested) {
          const fallback = buildObservationBasedFallbackOutcome(observations);
          if (fallback) {
            this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
            return fallback;
          }
          return { kind: 'blocked', message: '삭제 요청의 구조화된 근거가 부족해서 아무 작업도 실행하지 않았어요.', blockedTools: ['command.cleanup'] };
        }
        actionDecisionRetryRequested = true;
        validationFeedback = [
          '도구 호출 안전 검증에 실패했어요.',
          `오류: ${unsafeCallObservations.map((observation) => observation.message).filter(Boolean).join('; ')}`,
          '도구 입력을 고치거나 clarify/blocked로 답하세요. command.cleanup.evidence는 사용자 요청 또는 이어받은 문맥에 실제로 있는 문구여야 하며, 사용자에게 증거를 알려 달라고 묻지 마세요.'
        ].join('\n');
        continue;
      }

      const repeatedSuccessfulCalls = findRepeatedSuccessfulToolCalls(envelope.calls, toolCalls, observations);
      if (repeatedSuccessfulCalls.length) {
        const repeatedKeys = repeatedSuccessfulCalls.map(toolCallKey);
        const repeatedToolNames = [...new Set(repeatedSuccessfulCalls.map((call) => call.tool))];
        const alreadyRetried = repeatedKeys.some((key) => repeatedSuccessfulToolRetryKeys.has(key));
        await options.onDiagnostic?.({
          stage: 'agent',
          event: alreadyRetried ? 'decision' : 'retry',
          runId,
          iteration,
          decisionKind: alreadyRetried ? 'observation_based_final' : 'tool_observation_already_available',
          validationErrors: repeatedToolNames.map((toolName) => `${toolName} already has a successful observation; answer from existing observations`)
        });
        if (alreadyRetried) {
          const fallback = buildObservationBasedFallbackOutcome(observations);
          if (fallback) {
            this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
            return fallback;
          }
          return { kind: 'not_handled' };
        }
        for (const key of repeatedKeys) repeatedSuccessfulToolRetryKeys.add(key);
        validationFeedback = buildRepeatedSuccessfulToolFeedback(repeatedSuccessfulCalls, observations);
        continue;
      }

      const policies = envelope.calls.map((call) => this.registry.get(call.tool)?.policy ?? 'read_only_auto');
      const mixed = policies.some((policy) => policy === 'read_only_auto') && policies.some((policy) => policy !== 'read_only_auto');
      const nonExecutable = policies.filter((policy) => !isAutoExecutablePolicy(policy) && policy !== 'confirmation_required');
      if (mixed || nonExecutable.length > 0) {
        const blockedTools = envelope.calls
          .filter((call) => {
            const policy = this.registry.get(call.tool)?.policy ?? 'blocked';
            return mixed || (!isAutoExecutablePolicy(policy) && policy !== 'confirmation_required');
          })
          .map((call) => call.tool);
        await options.onDiagnostic?.({ stage: 'agent', event: 'blocked', runId, iteration, decisionKind: mixed ? 'mixed_tool_request' : 'non_auto_tool', validationErrors: blockedTools });
        for (const call of envelope.calls) {
          const policy = this.registry.get(call.tool)?.policy ?? 'blocked';
          const messageText = mixed
            ? 'Mixed action/read request is blocked; no tools executed.'
            : `Tool policy ${policy} is not auto-executable.`;
          observations.push({
            callId: call.id,
            toolName: call.tool,
            status: 'blocked',
            policy,
            code: mixed ? 'mixed_tool_request' : 'policy_blocked',
            message: messageText,
            hint: mixed
              ? 'Split read-only questions from execution/setting/deletion requests; no tools were executed.'
              : 'Do not execute this tool from the automatic agent loop; explain the block or use the supported confirmation/command path.',
            error: messageText
          });
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
      const confirmationOutcome = buildConfirmationRequiredOutcome(observations);
      if (confirmationOutcome) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'confirmation_required' });
        return confirmationOutcome;
      }
    }

    const fallback = buildObservationBasedFallbackOutcome(observations);
    if (fallback) {
      await options.onDiagnostic?.({ stage: 'agent', event: 'loop_limit', runId, decisionKind: fallback.kind === 'final' ? 'observation_based_final' : fallback.kind });
      this.updateTurnContext(key, fallback, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
      return fallback;
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
    const dynamicContext = [
      validationFeedback ? `재시도 지시:\n${validationFeedback}` : undefined,
      observations.length ? `도구 관찰 JSON: ${formatObservationsForPrompt(observations)}` : undefined,
      priorContext ? `이전 agent 문맥 JSON: ${JSON.stringify(sanitizePriorContextForPrompt(priorContext)).slice(0, 900)}` : undefined,
      options.conversationContext ? `conversation=${truncate(options.conversationContext, MAX_CONVERSATION_CONTEXT_CHARS)}` : undefined,
      options.pendingHistory ? `pendingHistory=${JSON.stringify(options.pendingHistory)}` : undefined,
      options.pendingConfirmation ? `pendingConfirmation=${JSON.stringify(options.pendingConfirmation)}` : undefined,
      `web=${formatWebSearchPolicy(options.webSearch)}`,
      `ctx=${formatRuntimeContextForPrompt(message, options)}`,
      `tools=${formatToolCatalogForPrompt(this.registry.list())}`
    ].filter(Boolean).join('\n');
    const system = [
      AGENT_OUTPUT_CONTRACT,
      truncate(dynamicContext, Math.max(0, MAX_SYSTEM_CHARS - AGENT_OUTPUT_CONTRACT.length - 1))
    ].filter(Boolean).join('\n');

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
    envelope: AgentRuntimeOutcome,
    prompt: string,
    calls: readonly AgentToolCall[],
    observations: readonly AgentToolObservation[],
    nowMs: number,
    priorContext: AgentTurnStoredContext | undefined
  ): void {
    if (envelope.kind === 'not_handled' || envelope.kind === 'confirm_pending') {
      this.contextStore.clear(key);
      return;
    }
    if (envelope.kind === 'final' && calls.length === 0) {
      if (priorContext && isReusableFollowUpIntent(priorContext.lastIntent) && !priorContext.pendingAction) {
        this.contextStore.set(key, {
          lastIntent: priorContext.lastIntent,
          lastUserPrompt: prompt,
          lastAgentMessage: envelope.message,
          lastToolCalls: priorContext.lastToolCalls,
          slots: priorContext.slots,
          observations: priorContext.observations
        }, nowMs);
        return;
      }
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
    const usedWebSearch = calls.some((call) => call.tool === 'web.search');
    const webSearchRelated = usedWebSearch || (envelope.kind === 'unavailable' && envelope.reason === 'web_search_unavailable');
    this.contextStore.set(key, {
      lastIntent: inferIntent(calls, envelope),
      lastUserPrompt: webSearchRelated ? '[redacted-web-search-prompt]' : prompt,
      lastAgentMessage: 'message' in envelope ? envelope.message : undefined,
      lastToolCalls: calls.map((call) => sanitizeToolCallForStoredContext(call)),
      slots,
      observations: observations.slice(-4).map((observation) => compactObservation(observation)),
      ...(envelope.kind === 'clarify'
        ? { pendingAction: envelope.pendingAction ?? priorContext?.pendingAction }
        : {})
    }, nowMs);
  }
}

function isReusableFollowUpIntent(intent: string | undefined): boolean {
  return intent === 'history' || intent === 'web_search' || intent === 'time' || intent === 'tarot';
}

function buildPendingActionBlockedFallback(pendingAction: AgentPendingAction | undefined): AgentRuntimeOutcome {
  if (pendingAction?.kind === 'tarot') {
    return {
      kind: 'blocked',
      message: '타로 카드 선택이 아직 처리되지 않았어요. 안내된 개수만큼 1~78 사이 숫자를 중복 없이 골라주세요.',
      blockedTools: ['tarot.reveal_selection']
    };
  }
  if (pendingAction?.kind === 'history') {
    return {
      kind: 'blocked',
      message: '대화 기록 요청의 필요한 범위가 아직 처리되지 않았어요. 채널이나 서버 범위를 다시 알려주세요.',
      blockedTools: ['history.search']
    };
  }
  return {
    kind: 'blocked',
    message: '메시지 삭제 요청의 대상이 아직 처리되지 않았어요. 제가 처리할 수 있는 건 요청자 본인 메시지 삭제나 관리자용 전체 채널 삭제뿐이에요.',
    blockedTools: ['command.cleanup']
  };
}

function buildPendingConfirmationFeedback(pending: NonNullable<AgentRuntimeOptions['pendingConfirmation']>): string {
  return [
    '현재 사용자 메시지는 대기 중인 확인 작업에 대한 답변일 수 있어요.',
    `대기 작업: ${pending.preview}`,
    `실행될 기존 명령: ${pending.commandQuery}`,
    '사용자 답변의 의미를 판단해서 이 작업을 승인한 것이 명확하면 {"kind":"confirm_pending"}만 출력하세요. ㅇ, ㅇㅇ, 응, 네, ok 같은 짧은 긍정도 문맥상 명확하면 승인으로 보세요.',
    '승인이 아니거나 애매하면 confirm_pending을 쓰지 말고 clarify/final/not_handled 중 적절한 JSON을 출력하세요.'
  ].join('\n');
}

function buildClarifyFollowUpFeedback(priorContext: AgentTurnStoredContext): string {
  return [
    '현재 사용자 메시지는 이전 clarify 질문에 대한 후속 답변일 수 있어요.',
    priorContext.lastUserPrompt ? `이전 사용자 요청: ${priorContext.lastUserPrompt}` : undefined,
    priorContext.lastAgentMessage ? `이전 clarify 질문: ${priorContext.lastAgentMessage}` : undefined,
    priorContext.pendingAction ? `이전 pendingAction JSON: ${JSON.stringify(priorContext.pendingAction)}` : undefined,
    '현재 답변과 이전 pendingAction/originalPrompt를 합쳐 명확해졌다면 cleanup은 command.cleanup 또는 command.mass_cleanup tool_calls JSON을, history는 history.search tool_calls JSON을, 타로 카드 선택 후속 답변은 tarot.reveal_selection tool_calls JSON을 작성하세요.',
    'cleanup에서 evidence는 사용자에게 물어보는 값이 아니에요. command.cleanup.evidence는 originalPrompt/현재 답변에 실제로 있는 문구를 그대로 쓰고, command.mass_cleanup에는 evidence를 넣지 마세요.',
    '이전 질문이 대화 기록/요약 범위를 묻는 clarify였다면, 현재 사용자 답변과 현재 채널/서버 문맥으로 범위를 해소해 history.search를 호출하세요. 이전 질문이 타로 카드 번호를 묻는 clarify였다면, 현재 답변의 번호를 AI가 구조화해 tarot.reveal_selection을 호출하고 숫자 검증 오류는 관찰값 그대로 사용자에게 안내하세요.',
    '현재 답변이 봇/다른 사람/지원하지 않는 대상의 메시지를 지우라는 의미라면 blocked JSON으로 "요청자 본인 메시지 삭제 또는 관리자용 전체 채널 삭제만 가능하다"고 자연스럽게 답하세요.',
    '아직 부족하면 업데이트된 pendingAction을 포함한 clarify JSON으로 추가 질문하세요. pendingAction이 남아 있는 동안에는 일반 대화가 아니라 해당 후속 답변으로 우선 처리하고, not_handled는 쓰지 마세요.'
  ].filter(Boolean).join('\n');
}

function buildPriorContextFollowUpFeedback(priorContext: AgentTurnStoredContext): string {
  return [
    '현재 사용자 메시지는 직전 agent 응답에 대한 후속 대화일 수 있어요.',
    priorContext.lastIntent ? `이전 의도: ${priorContext.lastIntent}` : undefined,
    priorContext.lastUserPrompt ? `이전 사용자 요청: ${priorContext.lastUserPrompt}` : undefined,
    priorContext.lastAgentMessage ? `직전 봇 응답: ${priorContext.lastAgentMessage}` : undefined,
    priorContext.lastToolCalls.length ? `이전 도구 호출 JSON: ${JSON.stringify(priorContext.lastToolCalls)}` : undefined,
    priorContext.observations.length ? `이전 도구 관찰 JSON: ${JSON.stringify(priorContext.observations).slice(0, 900)}` : undefined,
    '현재 사용자 메시지와 이전 문맥을 함께 보고 답할 수 있으면 final/clarify/unavailable/blocked 중 하나로 답하세요.',
    '특히 web_search_unavailable 후속 질문이면 현재 web 정책 JSON의 mode/providerStatus를 근거로 왜 검색할 수 없는지 설명하고, 사용자가 켤 수 있는 명령이 있으면 짧게 안내하세요.',
    '이전 문맥과 무관한 일반 대화가 확실할 때만 not_handled를 쓰세요.'
  ].filter(Boolean).join('\n');
}

function buildEmptyBlockedFeedback(): string {
  return [
    'blocked JSON에는 blockedTools에 실제 구조화 도구 이름이 있어야 해요.',
    '실행/설정/삭제 요청이면 적절한 tool_calls를 작성해서 코드의 확인/권한 경로가 처리하게 하세요.',
    '막을 구조화 도구가 없는 일반 대화라면 blocked가 아니라 not_handled를 쓰세요.'
  ].join('\n');
}

function parsePendingAction(raw: unknown): AgentPendingAction | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'history') return parseHistoryPendingAction(raw);
  if (raw.kind === 'tarot') return parseTarotPendingAction(raw);
  if (raw.kind !== 'cleanup') return undefined;
  const originalPrompt = typeof raw.originalPrompt === 'string' ? raw.originalPrompt.trim() : '';
  if (!originalPrompt) return undefined;
  const target = raw.target === 'self' || raw.target === 'channel' || raw.target === 'other' || raw.target === 'ambiguous'
    ? raw.target
    : undefined;
  const count = typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count > 0
    ? raw.count
    : undefined;
  const cleanupEvidence = typeof raw.cleanupEvidence === 'string' && raw.cleanupEvidence.trim()
    ? raw.cleanupEvidence.trim()
    : undefined;
  const rawMissing = Array.isArray(raw.missing) ? raw.missing : [];
  if (rawMissing.some((item) => item !== 'target' && item !== 'count')) return undefined;
  const missing = rawMissing.filter((item): item is 'target' | 'count' => item === 'target' || item === 'count');
  return {
    kind: 'cleanup',
    originalPrompt,
    ...(target ? { target } : {}),
    ...(count ? { count } : {}),
    ...(cleanupEvidence ? { cleanupEvidence } : {}),
    missing
  };
}


function parseTarotPendingAction(raw: Record<string, unknown>): AgentPendingAction | undefined {
  const originalPrompt = typeof raw.originalPrompt === 'string' ? raw.originalPrompt.trim() : '';
  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  const spreadCount = typeof raw.spreadCount === 'number' && Number.isInteger(raw.spreadCount) && raw.spreadCount >= 1 && raw.spreadCount <= 5
    ? raw.spreadCount
    : undefined;
  const spreadName = typeof raw.spreadName === 'string' && raw.spreadName.trim() ? raw.spreadName.trim() : undefined;
  if (!originalPrompt || !topic || !spreadCount) return undefined;
  const rawMissing = Array.isArray(raw.missing) ? raw.missing : [];
  if (rawMissing.some((item) => item !== 'numbers')) return undefined;
  const missing = rawMissing.filter((item): item is 'numbers' => item === 'numbers');
  return {
    kind: 'tarot',
    originalPrompt,
    topic,
    spreadCount,
    ...(spreadName ? { spreadName } : {}),
    missing
  };
}

function parseHistoryPendingAction(raw: Record<string, unknown>): AgentPendingAction | undefined {
  const originalPrompt = typeof raw.originalPrompt === 'string' ? raw.originalPrompt.trim() : '';
  if (!originalPrompt) return undefined;
  const scope = raw.scope === 'server' || raw.scope === 'channel' ? raw.scope : undefined;
  const channelRef = typeof raw.channelRef === 'string' && raw.channelRef.trim()
    ? raw.channelRef.trim()
    : undefined;
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  const mode = raw.mode === 'qa' || raw.mode === 'summary' ? raw.mode : undefined;
  if (!mode) return undefined;
  const rawMissing = Array.isArray(raw.missing) ? raw.missing : [];
  if (rawMissing.some((item) => item !== 'scope' && item !== 'channel')) return undefined;
  const missing = rawMissing.filter((item): item is 'scope' | 'channel' => item === 'scope' || item === 'channel');
  return {
    kind: 'history',
    originalPrompt,
    ...(scope ? { scope } : {}),
    ...(channelRef ? { channelRef } : {}),
    query,
    mode,
    missing
  };
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
  const kind = parseEnvelopeKind(parsed);
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
    case 'final': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) return { ok: false, errors: ['final.message must be non-empty'] };
      return { ok: true, envelope: { kind, message } };
    }
    case 'unavailable': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) return { ok: false, errors: ['unavailable.message must be non-empty'] };
      const reason = parsed.reason === 'web_search_unavailable' ? parsed.reason : undefined;
      return { ok: true, envelope: reason ? { kind, message, reason } : { kind, message } };
    }
    case 'clarify': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!message) return { ok: false, errors: ['clarify.message must be non-empty'] };
      const pendingAction = parsePendingAction(parsed.pendingAction);
      if (parsed.pendingAction !== undefined && !pendingAction) {
        return { ok: false, errors: ['clarify.pendingAction is invalid or uses unsupported missing fields; pendingAction missing fields must match the action; cleanup missing may only include target/count and must not ask for evidence; tarot missing may only include numbers'] };
      }
      return { ok: true, envelope: pendingAction ? { kind, message, pendingAction } : { kind, message } };
    }
    case 'blocked': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const blockedTools = Array.isArray(parsed.blockedTools) ? parsed.blockedTools.filter((item): item is string => typeof item === 'string') : [];
      if (!message) return { ok: false, errors: ['blocked.message must be non-empty'] };
      return { ok: true, envelope: { kind: 'blocked', message, blockedTools } };
    }
    case 'confirm_pending':
      return { ok: true, envelope: { kind: 'confirm_pending' } };
    case 'not_handled':
      return { ok: true, envelope: { kind: 'not_handled' } };
    default:
      return { ok: false, errors: [`Unknown kind: ${kind || '(missing)'}`] };
  }
}

function parseEnvelopeKind(parsed: Record<string, unknown>): string {
  if (typeof parsed.kind === 'string') return parsed.kind;
  const alias = typeof parsed.status === 'string'
    ? parsed.status
    : typeof parsed.action === 'string'
      ? parsed.action
      : '';
  if (
    alias === 'not_handled'
    || alias === 'confirm_pending'
    || alias === 'final'
    || alias === 'clarify'
    || alias === 'unavailable'
    || alias === 'blocked'
  ) {
    return alias;
  }
  return '';
}

function isEmptyBlockedDecision(
  envelope: AgentEnvelope,
  observations: readonly AgentToolObservation[],
  toolCalls: readonly AgentToolCall[]
): boolean {
  if (observations.length || toolCalls.length) return false;
  return envelope.kind === 'blocked' && envelope.blockedTools.length === 0;
}

function findRepeatedSuccessfulToolCalls(
  calls: readonly AgentToolCall[],
  previousCalls: readonly AgentToolCall[],
  observations: readonly AgentToolObservation[]
): AgentToolCall[] {
  const successfulCallIds = new Set(observations
    .filter((observation) => observation.status === 'ok' && (observation.policy === 'read_only_auto' || observation.policy === 'safe_action_auto'))
    .map((observation) => observation.callId));
  if (!successfulCallIds.size) return [];
  const successfulToolKeys = new Set(previousCalls
    .filter((call) => successfulCallIds.has(call.id))
    .map(toolCallKey));
  return calls.filter((call) => successfulToolKeys.has(toolCallKey(call)));
}

function toolCallKey(call: AgentToolCall): string {
  return `${call.tool}\u0000${stableStringify(call.input)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isAutoExecutablePolicy(policy: AgentToolPolicy): boolean {
  return policy === 'read_only_auto' || policy === 'safe_action_auto';
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
  }
  return errors;
}

function validateToolCallSafety(
  calls: readonly AgentToolCall[],
  prompt: string,
  priorContext: AgentTurnStoredContext | undefined
): AgentToolObservation[] {
  const observations: AgentToolObservation[] = [];
  const evidenceSources = [
    prompt,
    priorContext?.lastUserPrompt,
    priorContext?.lastAgentMessage,
    priorContext?.pendingAction?.kind === 'cleanup' ? priorContext.pendingAction.originalPrompt : undefined,
    priorContext?.pendingAction?.kind === 'cleanup' ? priorContext.pendingAction.cleanupEvidence : undefined
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  for (const call of calls) {
    if (call.tool !== 'command.cleanup' || !isRecord(call.input)) continue;
    const evidence = typeof call.input.evidence === 'string' ? call.input.evidence.trim() : '';
    if (!evidence || evidenceSources.some((source) => containsEvidence(source, evidence))) continue;
    observations.push({
      callId: call.id,
      toolName: call.tool,
      status: 'error',
      policy: 'confirmation_required',
      code: 'validation_error',
      field: 'evidence',
      message: 'command.cleanup.evidence must be exact text from the current user request or stored follow-up context',
      hint: 'Use only a literal phrase the user actually wrote as cleanup evidence. Never ask the user to provide evidence; clarify only target/count ambiguity or block unsupported targets.',
      error: 'command.cleanup.evidence must match user text'
    });
  }
  return observations;
}

function containsEvidence(source: string, evidence: string): boolean {
  return normalizeEvidenceText(source).includes(normalizeEvidenceText(evidence));
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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
    code: observation.code,
    field: observation.field,
    message: observation.message,
    hint: observation.hint,
    confirmation: observation.confirmation
      ? {
        intent: observation.confirmation.intent,
        preview: observation.confirmation.preview,
        commandQuery: observation.confirmation.commandQuery
      }
      : undefined,
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
  if (observation.toolName === 'web.search') {
    const results = isRecord(observation.output) && Array.isArray(observation.output.results)
      ? observation.output.results.length
      : undefined;
    return JSON.stringify({
      ...base,
      provider: isRecord(observation.output) ? observation.output.provider : undefined,
      results
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
  if (observation.toolName === 'web.search') {
    return sanitizeWebSearchObservation(observation);
  }
  return {
    callId: observation.callId,
    toolName: observation.toolName,
    status: observation.status,
    policy: observation.policy,
    code: observation.code,
    field: observation.field,
    message: observation.message,
    hint: observation.hint,
    confirmation: observation.confirmation,
    output: observation.output,
    error: observation.error
  };
}


function withTrustedPresentation(envelope: Exclude<AgentEnvelope, { kind: 'tool_calls' }>, observations: readonly AgentToolObservation[]): AgentRuntimeOutcome {
  if (envelope.kind !== 'final') return envelope;
  const presentation = extractTrustedPresentation(observations);
  return presentation ? { ...envelope, presentation } : envelope;
}

function extractTrustedPresentation(observations: readonly AgentToolObservation[]): AgentDiscordPresentation | undefined {
  for (const observation of [...observations].reverse()) {
    if (observation.toolName !== 'tarot.reveal_selection' || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const presentation = observation.output.presentation;
    if (!isRecord(presentation)) continue;
    return sanitizePresentation(presentation);
  }
  return undefined;
}

function sanitizePresentation(raw: Record<string, unknown>): AgentDiscordPresentation | undefined {
  const files = Array.isArray(raw.files)
    ? raw.files.flatMap((file) => {
      if (!isRecord(file) || typeof file.path !== 'string' || typeof file.name !== 'string') return [];
      if (!file.path.startsWith('assets/tarot/') || file.path.includes('..') || !file.name.endsWith('.png')) return [];
      return [{ path: file.path, name: file.name }];
    }).slice(0, 5)
    : undefined;
  const cards = Array.isArray(raw.cards)
    ? raw.cards.flatMap((card) => {
      if (!isRecord(card)) return [];
      const selectionNumber = typeof card.selectionNumber === 'number' && Number.isInteger(card.selectionNumber) ? card.selectionNumber : undefined;
      const name = typeof card.name === 'string' ? card.name.trim() : '';
      const orientation = typeof card.orientation === 'string' ? card.orientation.trim() : '';
      const attachmentName = typeof card.attachmentName === 'string' ? card.attachmentName.trim() : undefined;
      if (!selectionNumber || !name || !orientation) return [];
      return [{ selectionNumber, name, orientation, ...(attachmentName ? { attachmentName } : {}) }];
    }).slice(0, 5)
    : undefined;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : undefined;
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 1000) : undefined;
  if (!title && !summary && !files?.length && !cards?.length) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(files?.length ? { files } : {}),
    ...(cards?.length ? { cards } : {})
  };
}

function inferIntent(calls: readonly AgentToolCall[], envelope: AgentRuntimeOutcome): string | undefined {
  if (calls.some((call) => call.tool.startsWith('time.'))) return 'time';
  if (calls.some((call) => call.tool.startsWith('history.'))) return 'history';
  if (calls.some((call) => call.tool === 'web.search')) return 'web_search';
  if (calls.some((call) => call.tool.startsWith('voice.'))) return 'voice';
  if (calls.some((call) => call.tool.startsWith('tarot.'))) return 'tarot';
  if (envelope.kind === 'unavailable' && envelope.reason === 'web_search_unavailable') return 'web_search';
  return envelope.kind;
}

function formatRuntimeContextForPrompt(message: Message, options: AgentRuntimeOptions): string {
  const channels = selectPromptChannels(message.channelId, options.availableChannels);
  return JSON.stringify({
    channel: `<#${message.channelId}>`,
    prefix: options.prefix,
    requester: options.requesterDisplayName,
    userVoice: options.userVoiceChannel
      ? { id: options.userVoiceChannel.id, name: options.userVoiceChannel.name ?? undefined }
      : null,
    voiceSemantics: {
      userVoice: 'requester_voice_channel_not_bot_location',
      botVoice: 'botVoiceConnected_and_botVoiceChannel_are_bot_location_source_of_truth'
    },
    botVoiceConnected: Boolean(options.botVoiceConnected),
    botVoiceChannel: options.botVoiceConnected && options.botVoiceChannel
      ? { id: options.botVoiceChannel.id, name: options.botVoiceChannel.name ?? undefined }
      : null,
    channels: channels.map((channel) => ({ id: channel.id, name: channel.name, mention: channel.mention })),
    channelCount: options.availableChannels.length,
    channelsTruncated: options.availableChannels.length > channels.length,
    tarotPending: options.tarotPending ? {
      topic: options.tarotPending.topic,
      spreadCount: options.tarotPending.spreadCount,
      spreadName: options.tarotPending.spreadName,
      expiresAt: options.tarotPending.expiresAt,
      requesterDisplayName: options.tarotPending.requesterDisplayName
    } : undefined,
    now: `<t:${Math.floor(options.executionContext.nowMs / 1000)}:t>`
  });
}

function selectPromptChannels(
  currentChannelId: string,
  channels: readonly { id: string; name: string; mention: string }[]
): readonly { id: string; name: string; mention: string }[] {
  const selected: { id: string; name: string; mention: string }[] = [];
  const current = channels.find((channel) => channel.id === currentChannelId);
  if (current) selected.push(current);
  for (const channel of channels) {
    if (selected.length >= MAX_PROMPT_CHANNELS) break;
    if (channel.id === currentChannelId) continue;
    selected.push(channel);
  }
  return selected;
}

function formatToolCatalogForPrompt(tools: ReturnType<ToolRegistry['list']>): string {
  return [...tools].sort(compareToolPromptPriority).map(formatToolDetailForPrompt).join(' | ');
}

function formatToolDetailForPrompt(tool: AgentToolDefinition): string {
  return `${tool.name} [${tool.policy}] input=${truncate(tool.inputSchema, 180)} :: ${truncate(tool.description, 44)}`;
}

const TOOL_PROMPT_PRIORITY = [
  'runtime.context',
  'history.search',
  'history.summarize',
  'voice.speak',
  'tarot.start_reading',
  'tarot.reveal_selection',
  'web.search'
] as const;

function compareToolPromptPriority(left: AgentToolDefinition, right: AgentToolDefinition): number {
  const leftIndex = TOOL_PROMPT_PRIORITY.indexOf(left.name as (typeof TOOL_PROMPT_PRIORITY)[number]);
  const rightIndex = TOOL_PROMPT_PRIORITY.indexOf(right.name as (typeof TOOL_PROMPT_PRIORITY)[number]);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }
  return left.name.localeCompare(right.name);
}

function formatWebSearchPolicy(webSearch: AgentRuntimeOptions['webSearch']): string {
  if (!webSearch) return JSON.stringify({ status: 'unavailable', rule: 'do not call web.search; use unavailable for explicit search needs' });
  const rule = webSearch.mode === 'disabled'
    ? 'do not call web.search; explicit search needs unavailable'
    : webSearch.providerStatus !== 'ready'
      ? 'provider not ready; explicit factual/search needs unavailable'
      : webSearch.mode === 'explicit_only'
        ? 'call only when user explicitly asks web/search/latest/source check'
        : webSearch.mode === 'automatic'
          ? 'call when current/external/uncertain facts materially affect quality'
          : 'search first for current/external/verifiable factual questions';
  return JSON.stringify({
    mode: webSearch.mode,
    provider: webSearch.provider,
    providerStatus: webSearch.providerStatus,
    resultCount: webSearch.resultCount,
    rule,
    citation: 'when answering from web.search, cite result numbers and include source title/url list'
  });
}

function buildWebSearchFailureOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const webFailure = [...observations].reverse().find((observation) => observation.toolName === 'web.search' && observation.status === 'error');
  if (!webFailure) return null;
  return {
    kind: 'unavailable',
    reason: 'web_search_unavailable',
    message: `웹 검색 도구를 사용할 수 없어 확인이 필요한 답변을 만들 수 없어요. ${webFailure.error ? `사유: ${webFailure.error}` : 'SearXNG 설정이나 상태를 확인해 주세요.'}`
  };
}

function buildObservationBasedFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const webFailure = buildWebSearchFailureOutcome(observations);
  if (webFailure) return webFailure;
  const historyFallback = buildHistoryFallbackOutcome(observations);
  if (historyFallback) return historyFallback;
  const historySummaryFallback = buildHistorySummaryFallbackOutcome(observations);
  if (historySummaryFallback) return historySummaryFallback;
  const timeFallback = buildTimeFallbackOutcome(observations);
  if (timeFallback) return timeFallback;
  const voiceFallback = buildVoiceFallbackOutcome(observations);
  if (voiceFallback) return voiceFallback;
  const tarotFallback = buildTarotFallbackOutcome(observations);
  if (tarotFallback) return tarotFallback;
  const webSources = extractSuccessfulWebSearchSources(observations);
  if (!webSources.length) return null;
  return {
    kind: 'final',
    message: [
      '검색 결과는 받았는데 답변 정리를 끝내지 못했어요...',
      '확인된 출처만 먼저 남길게요. 아래 주소 기준으로 다시 물어보면 이어서 정리할 수 있어요...',
      '출처:',
      ...webSources.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`)
    ].join('\n')
  };
}

function buildConfirmationRequiredOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const observation = observations.find((item) => item.status === 'confirmation_required' && item.confirmation?.commandQuery);
  if (!observation?.confirmation?.commandQuery) return null;
  return {
    kind: 'confirmation_required',
    message: observation.message ?? `${observation.toolName} 실행 전 확인이 필요해요...`,
    intent: observation.confirmation.intent,
    preview: observation.confirmation.preview,
    payload: observation.confirmation.payload,
    commandQuery: observation.confirmation.commandQuery
  };
}

function hasUsableObservation(observations: readonly AgentToolObservation[]): boolean {
  return hasSuccessfulWebSearchObservation(observations)
    || hasSuccessfulHistorySearchObservation(observations)
    || hasSuccessfulHistorySummaryObservation(observations)
    || hasSuccessfulTimeObservation(observations)
    || hasSuccessfulVoiceObservation(observations)
    || hasTarotObservation(observations);
}


function hasTarotObservation(observations: readonly AgentToolObservation[]): boolean {
  return observations.some((observation) => observation.toolName.startsWith('tarot.'));
}

function hasSuccessfulWebSearchObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulWebSearchSources(observations).length > 0;
}

function hasSuccessfulHistorySearchObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulHistoryEvidence(observations).length > 0;
}

function hasSuccessfulHistorySummaryObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulHistorySummaries(observations).length > 0;
}

function hasSuccessfulTimeObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulTimeOutputs(observations).length > 0;
}

function hasSuccessfulVoiceObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulVoiceMessages(observations).length > 0;
}

function buildRepeatedSuccessfulToolFeedback(repeatedCalls: readonly AgentToolCall[], observations: readonly AgentToolObservation[]): string {
  return [
    '이미 같은 입력의 도구 성공 관찰값이 있어요.',
    `반복 도구: ${[...new Set(repeatedCalls.map((call) => call.tool))].join(', ')}`,
    '이미 성공한 같은 입력의 도구를 다시 호출하지 말고, 현재 도구 관찰 JSON만 근거로 final/unavailable/blocked 중 하나를 작성하세요.',
    '관찰값에 없는 내용은 단정하지 말고 확인된 내용 기준이라고 밝혀요.',
    ...formatObservationEvidenceForFeedback(observations)
  ].join('\n');
}

function formatObservationEvidenceForFeedback(observations: readonly AgentToolObservation[]): string[] {
  const parts: string[] = [];
  const webSources = extractSuccessfulWebSearchSources(observations);
  if (webSources.length) {
    parts.push('웹 출처:', ...webSources.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`));
  }
  const historyEvidence = extractSuccessfulHistoryEvidence(observations);
  if (historyEvidence.length) parts.push(...formatHistoryEvidenceForFeedback(historyEvidence));
  const historySummaries = extractSuccessfulHistorySummaries(observations);
  if (historySummaries.length) parts.push('대화 요약:', ...historySummaries.map((summary, index) => `[${index + 1}] ${truncate(summary, 180)}`));
  const timeOutputs = extractSuccessfulTimeOutputs(observations);
  if (timeOutputs.length) parts.push('시간 관찰:', ...timeOutputs.map((item, index) => `[${index + 1}] ${item.label}: ${item.display} (${item.timeZone})`));
  const voiceMessages = extractSuccessfulVoiceMessages(observations);
  if (voiceMessages.length) parts.push('작업 관찰:', ...voiceMessages.map((message, index) => `[${index + 1}] ${message}`));
  return parts;
}

function buildObservationAnswerRequiredFeedback(observations: readonly AgentToolObservation[]): string {
  const parts = [
    '도구 관찰값을 이미 받았기 때문에 not_handled를 사용할 수 없어요.',
    '추가 도구 호출 없이 현재 도구 관찰 JSON만 근거로 final/unavailable/blocked 중 하나를 작성하세요.'
  ];
  const webSources = extractSuccessfulWebSearchSources(observations);
  if (webSources.length) {
    parts.push('웹 출처:', ...webSources.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`));
  }
  const historyEvidence = extractSuccessfulHistoryEvidence(observations);
  if (historyEvidence.length) {
    parts.push(...formatHistoryEvidenceForFeedback(historyEvidence));
  }
  const historySummaries = extractSuccessfulHistorySummaries(observations);
  if (historySummaries.length) {
    parts.push('대화 요약:', ...historySummaries.map((summary, index) => `[${index + 1}] ${truncate(summary, 180)}`));
  }
  const timeOutputs = extractSuccessfulTimeOutputs(observations);
  if (timeOutputs.length) {
    parts.push('시간 관찰:', ...timeOutputs.map((item, index) => `[${index + 1}] ${item.label}: ${item.display} (${item.timeZone})`));
  }
  const voiceMessages = extractSuccessfulVoiceMessages(observations);
  if (voiceMessages.length) {
    parts.push('작업 관찰:', ...voiceMessages.map((message, index) => `[${index + 1}] ${message}`));
  }
  return parts.join('\n');
}

function formatHistoryEvidenceForFeedback(evidence: ReturnType<typeof extractSuccessfulHistoryEvidence>): string[] {
  if (!evidence.length) return ['대화 증거: (없음)'];
  return [
    '대화 증거:',
    ...evidence.slice(0, 8).map((item, index) => `[${index + 1}] ${item.authorName}: ${truncate(item.content.replace(/\s+/g, ' '), 140)}`)
  ];
}

function extractSuccessfulWebSearchSources(observations: readonly AgentToolObservation[]): { title: string; url: string }[] {
  const sources: { title: string; url: string }[] = [];
  const seenUrls = new Set<string>();
  for (const observation of observations) {
    if (observation.toolName !== 'web.search' || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const results = Array.isArray(observation.output.results) ? observation.output.results : [];
    for (const result of results) {
      if (!isRecord(result) || typeof result.url !== 'string' || !result.url.trim() || seenUrls.has(result.url)) continue;
      const title = typeof result.title === 'string' && result.title.trim()
        ? truncate(result.title.trim(), 120)
        : result.url;
      sources.push({ title, url: result.url });
      seenUrls.add(result.url);
      if (sources.length >= 5) return sources;
    }
  }
  return sources;
}

function extractSuccessfulHistoryEvidence(observations: readonly AgentToolObservation[]): Array<{ authorName: string; content: string }> {
  const evidence: Array<{ authorName: string; content: string }> = [];
  for (const observation of observations) {
    if (observation.toolName !== 'history.search' || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const rows = Array.isArray(observation.output.evidence) ? observation.output.evidence : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const content = typeof row.content === 'string' ? row.content.trim() : '';
      if (!content) continue;
      evidence.push({
        authorName: typeof row.authorName === 'string' && row.authorName.trim() ? row.authorName.trim() : '알 수 없음',
        content
      });
      if (evidence.length >= 12) return evidence;
    }
  }
  return evidence;
}

function buildHistoryFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const evidence = extractSuccessfulHistoryEvidence(observations);
  if (!evidence.length) return null;
  return {
    kind: 'final',
    message: [
      '읽은 메시지 기준으로 찾은 내용이에요...',
      ...evidence.slice(0, 6).map((item) => `${item.authorName}: ${truncate(item.content.replace(/\s+/g, ' '), 260)}`)
    ].join('\n')
  };
}

function extractSuccessfulHistorySummaries(observations: readonly AgentToolObservation[]): string[] {
  const summaries: string[] = [];
  for (const observation of observations) {
    if (observation.toolName !== 'history.summarize' || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const message = typeof observation.output.message === 'string' ? observation.output.message.trim() : '';
    if (!message) continue;
    summaries.push(message);
    if (summaries.length >= 4) return summaries;
  }
  return summaries;
}

function buildHistorySummaryFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const summaries = extractSuccessfulHistorySummaries(observations);
  if (!summaries.length) return null;
  return {
    kind: 'final',
    message: [
      '대화 요약 관찰값 기준으로 답할게요...',
      ...summaries.slice(0, 4).map((summary) => truncate(summary.replace(/\s+/g, ' '), 280))
    ].join('\n')
  };
}

function extractSuccessfulTimeOutputs(observations: readonly AgentToolObservation[]): Array<{ label: string; timeZone: string; display: string; epochSeconds?: number }> {
  const outputs: Array<{ label: string; timeZone: string; display: string; epochSeconds?: number }> = [];
  for (const observation of observations) {
    if (!observation.toolName.startsWith('time.') || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const display = typeof observation.output.display === 'string'
      ? observation.output.display.trim()
      : typeof observation.output.timestampTag === 'string'
        ? observation.output.timestampTag.trim()
        : '';
    if (!display) continue;
    const timeZone = typeof observation.output.timeZone === 'string' && observation.output.timeZone.trim()
      ? observation.output.timeZone.trim()
      : 'viewer-local';
    const label = typeof observation.output.label === 'string' && observation.output.label.trim()
      ? observation.output.label.trim()
      : timeZone;
    outputs.push({
      label,
      timeZone,
      display,
      ...(typeof observation.output.epochSeconds === 'number' ? { epochSeconds: observation.output.epochSeconds } : {})
    });
    if (outputs.length >= 8) return outputs;
  }
  return outputs;
}

function buildTimeFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const outputs = extractSuccessfulTimeOutputs(observations);
  if (!outputs.length) return null;
  return {
    kind: 'final',
    message: [
      '확인한 시간 관찰값 기준으로 답할게요...',
      ...outputs.map((item) => `${item.label}: ${item.display}`)
    ].join('\n')
  };
}

function extractSuccessfulVoiceMessages(observations: readonly AgentToolObservation[]): string[] {
  const messages: string[] = [];
  for (const observation of observations) {
    if (!isMessageFallbackTool(observation.toolName) || observation.status !== 'ok' || !isRecord(observation.output)) continue;
    const message = typeof observation.output.message === 'string' ? observation.output.message.trim() : '';
    if (!message) continue;
    messages.push(message);
    if (messages.length >= 4) return messages;
  }
  return messages;
}

function isMessageFallbackTool(toolName: string): boolean {
  return toolName.startsWith('voice.') || toolName.startsWith('tts.') || toolName === 'time.user_timezone';
}


function buildTarotFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const latest = [...observations].reverse().find((observation) => observation.toolName.startsWith('tarot.'));
  if (!latest) return null;
  if (latest.status !== 'ok') {
    return {
      kind: 'blocked',
      message: latest.message ?? '타로 카드 선택을 처리하지 못했어요. 안내된 개수만큼 1~78 사이 숫자를 중복 없이 골라주세요.',
      blockedTools: [latest.toolName]
    };
  }
  if (!isRecord(latest.output)) return null;
  const outputMessage = typeof latest.output.message === 'string' ? latest.output.message : '타로 관찰값을 확인했어요.';
  if (latest.toolName === 'tarot.reveal_selection') {
    const presentation = extractTrustedPresentation(observations);
    return presentation ? { kind: 'final', message: outputMessage, presentation } : { kind: 'final', message: outputMessage };
  }
  return { kind: 'clarify', message: outputMessage };
}

function buildVoiceFallbackOutcome(observations: readonly AgentToolObservation[]): AgentRuntimeOutcome | null {
  const messages = extractSuccessfulVoiceMessages(observations);
  if (!messages.length) return null;
  return {
    kind: 'final',
    message: [
      '작업 관찰값 기준으로 답할게요...',
      ...messages.slice(0, 4)
    ].join('\n')
  };
}

function formatObservationsForPrompt(observations: readonly AgentToolObservation[]): string {
  return JSON.stringify(observations.map((observation) => observation.toolName === 'web.search'
    ? sanitizeWebSearchObservation(observation)
    : observation)).slice(0, MAX_OBSERVATION_CHARS);
}

function summarizePromptForDiagnostic(messages: readonly AiChatMessage[]): string {
  return messages
    .map((item) => {
      if (item.role === 'user') return '사용자 메시지: [redacted-for-diagnostics]';
      return item.content
        .replace(/이전 agent 문맥 JSON:[\s\S]*?(?=\n도구 관찰 JSON:|\n재시도 지시:|$)/u, '이전 agent 문맥 JSON: [redacted-for-diagnostics]')
        .replace(/도구 관찰 JSON:[\s\S]*/u, '도구 관찰 JSON: [redacted-for-diagnostics]');
    })
    .join('\n')
    .slice(0, 500);
}

function sanitizeWebSearchObservation(observation: AgentToolObservation): unknown {
  const base = {
    callId: observation.callId,
    toolName: observation.toolName,
    status: observation.status,
    policy: observation.policy,
    code: observation.code,
    field: observation.field,
    message: observation.message,
    hint: observation.hint,
    confirmation: observation.confirmation,
    error: observation.error
  };
  if (!isRecord(observation.output)) {
    return base;
  }
  const results = Array.isArray(observation.output.results)
    ? observation.output.results.filter(isRecord).slice(0, 10).map((result) => ({
      title: typeof result.title === 'string' ? truncate(result.title, 140) : undefined,
      url: typeof result.url === 'string' ? result.url : undefined,
      sourceDomain: typeof result.sourceDomain === 'string' ? result.sourceDomain : undefined,
      publishedAt: typeof result.publishedAt === 'string' ? result.publishedAt : undefined,
      snippet: typeof result.snippet === 'string' ? truncate(result.snippet, 180) : undefined
    }))
    : undefined;
  return {
    ...base,
    output: {
      provider: observation.output.provider,
      results
    },
  };
}

function sanitizePriorContextForPrompt(context: AgentTurnStoredContext): AgentTurnStoredContext {
  return {
    ...context,
    lastToolCalls: context.lastToolCalls.map((call) => sanitizeToolCallForStoredContext(call)),
    observations: context.observations.map((observation) => sanitizeStoredObservation(observation))
  };
}

function sanitizeToolCallForStoredContext(call: { tool: string; input: unknown }): { tool: string; input: unknown } {
  if (call.tool !== 'web.search' || !isRecord(call.input)) return { tool: call.tool, input: call.input };
  const safeInput = { ...call.input };
  delete safeInput.query;
  return {
    tool: call.tool,
    input: {
      ...safeInput,
      query: '[redacted-web-search-query]'
    }
  };
}

function sanitizeStoredObservation(observation: unknown): unknown {
  if (!isRecord(observation) || observation.toolName !== 'web.search') return observation;
  if (!isRecord(observation.output)) return observation;
  const safeOutput = { ...observation.output };
  delete safeOutput.query;
  return { ...observation, output: safeOutput };
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
