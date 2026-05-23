import type { Message } from 'discord.js';
import type { AiDetailedResponse, AiService } from './aiService.js';
import { extractErrorDetails, type AiChatMessage } from './aiService.js';
import type { AgentPendingAction, AgentTurnContextStore, AgentTurnStoredContext } from './agentTurnContextStore.js';
import type { AgentToolExecutionContext, AgentToolObservation, AgentToolPolicy, ToolRegistry } from './toolRegistry.js';
import type { WebSearchMode, WebSearchProviderName, WebSearchProviderStatus } from './webSearchService.js';

const MAX_ITERATIONS = 4;
const MAX_TOTAL_TOOL_CALLS = 8;
const MAX_CALLS_PER_ENVELOPE = 4;
const MAX_RETRIES = 1;
const MAX_PROMPT_CHARS = 1800;
const MAX_OBSERVATION_CHARS = 1400;
const MAX_SYSTEM_CHARS = 9000;

export type AgentRuntimeOutcome =
  | { kind: 'final'; message: string }
  | { kind: 'clarify'; message: string; pendingAction?: AgentPendingAction }
  | { kind: 'unavailable'; message: string; reason?: 'web_search_unavailable' }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'legacy_command'; query: string; cleanupTarget?: 'self' | 'channel' | 'other' | 'ambiguous'; cleanupEvidence?: string }
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
  maxCompletionTokens?: number;
  pendingHistory?: { mode: 'summary' | 'qa'; query: string } | null;
  pendingConfirmation?: { preview: string; commandQuery: string; intent: string; normalizedArgs: string } | null;
  webSearch?: {
    mode: WebSearchMode;
    provider: WebSearchProviderName;
    providerStatus: WebSearchProviderStatus;
    resultCount: number;
  };
  executionContext: AgentToolExecutionContext;
  onDiagnostic?: (details: AgentRuntimeDiagnostic) => Promise<void> | void;
};

type AgentEnvelope =
  | { kind: 'tool_calls'; calls: AgentToolCall[] }
  | { kind: 'final'; message: string }
  | { kind: 'clarify'; message: string; pendingAction?: AgentPendingAction }
  | { kind: 'unavailable'; message: string; reason?: 'web_search_unavailable' }
  | { kind: 'blocked'; message: string; blockedTools: string[] }
  | { kind: 'legacy_command'; query: string; cleanupTarget?: 'self' | 'channel' | 'other' | 'ambiguous'; cleanupEvidence?: string }
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
      if (envelope.kind === 'blocked' && shouldRetryLegacyActionDecision(envelope.blockedTools, priorContext) && !actionDecisionRetryRequested) {
        await options.onDiagnostic?.({
          stage: 'agent',
          event: 'retry',
          runId,
          iteration,
          decisionKind: 'legacy_action_decision_required',
          validationErrors: envelope.blockedTools
        });
        actionDecisionRetryRequested = true;
        validationFailureFallback = envelope;
        validationFeedback = buildLegacyActionDecisionFeedback(envelope.blockedTools, options.requesterDisplayName);
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
        validationFailureFallback = {
          kind: 'blocked',
          message: '메시지 삭제 요청의 대상이 아직 명확하지 않아요. 본인 메시지 삭제나 관리자용 전체 채널 삭제만 가능해요.',
          blockedTools: ['command.cleanup']
        };
        validationFeedback = buildClarifyFollowUpFeedback(priorContext);
        continue;
      }
      if (envelope.kind === 'not_handled' && priorContext?.pendingAction) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'blocked', runId, iteration, decisionKind: 'pending_action_not_resolved' });
        this.updateTurnContext(key, { kind: 'clarify', message: 'pending action unresolved', pendingAction: priorContext.pendingAction }, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return {
          kind: 'blocked',
          message: '메시지 삭제 요청의 대상이 아직 처리되지 않았어요. 제가 처리할 수 있는 건 요청자 본인 메시지 삭제나 관리자용 전체 채널 삭제뿐이에요.',
          blockedTools: ['command.cleanup']
        };
      }
      validationFeedback = null;
      const webSearchFailure = buildWebSearchFailureOutcome(observations);
      if ((envelope.kind === 'not_handled' || envelope.kind === 'final') && webSearchFailure) {
        await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'web_search_unavailable' });
        this.updateTurnContext(key, webSearchFailure, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return webSearchFailure;
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
      if (envelope.kind === 'legacy_command') {
        const cleanupValidation = validateLegacyCleanupCommand(envelope.query, envelope.cleanupTarget, envelope.cleanupEvidence, prompt, priorContext);
        if (!cleanupValidation.ok) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: cleanupValidation.reason });
          if (actionDecisionRetryRequested) {
            return { kind: 'blocked', message: '채팅 삭제 대상이 명확하지 않아 아무 작업도 실행하지 않았어요.', blockedTools: ['command.cleanup'] };
          }
          actionDecisionRetryRequested = true;
          validationFailureFallback = {
            kind: 'blocked',
            message: '채팅 삭제 대상이 명확하지 않아 아무 작업도 실행하지 않았어요.',
            blockedTools: ['command.cleanup']
          };
          validationFeedback = buildCleanupTargetFeedback(cleanupValidation.reason, priorContext, options.requesterDisplayName);
          continue;
        }
      }
      if (envelope.kind !== 'tool_calls') {
        if (envelope.kind === 'final' && toolCalls.length === 0 && observations.length === 0 && !priorContext) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'decision', runId, iteration, decisionKind: 'final_without_observation' });
          return { kind: 'not_handled', reason: 'final_without_observation' };
        }
        await options.onDiagnostic?.({ stage: 'agent', event: envelope.kind === 'final' ? 'final' : 'decision', runId, iteration, decisionKind: envelope.kind });
        this.updateTurnContext(key, envelope, prompt, toolCalls, observations, options.executionContext.nowMs, priorContext);
        return envelope;
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

      if (hasSuccessfulWebSearchObservation(observations) && envelope.calls.some((call) => call.tool === 'web.search')) {
        await options.onDiagnostic?.({
          stage: 'agent',
          event: 'retry',
          runId,
          iteration,
          decisionKind: 'web_search_observation_already_available',
          validationErrors: ['web.search already has successful observations; answer from existing sources']
        });
        validationFeedback = buildExistingWebSearchObservationFeedback(observations);
        continue;
      }
      if (hasSuccessfulHistorySearchObservation(observations) && envelope.calls.some((call) => call.tool === 'history.search')) {
        await options.onDiagnostic?.({
          stage: 'agent',
          event: 'retry',
          runId,
          iteration,
          decisionKind: 'history_search_observation_already_available',
          validationErrors: ['history.search already has successful observations; answer from existing evidence']
        });
        validationFeedback = buildExistingHistorySearchObservationFeedback(observations);
        continue;
      }

      const policies = envelope.calls.map((call) => this.registry.get(call.tool)?.policy ?? 'blocked');
      const nonReadOnly = policies.filter((policy) => policy !== 'read_only_auto');
      if (nonReadOnly.length > 0) {
        const blockedTools = envelope.calls.filter((call) => this.registry.get(call.tool)?.policy !== 'read_only_auto').map((call) => call.tool);
        const mixed = policies.some((policy) => policy === 'read_only_auto') && nonReadOnly.length > 0;
        if (!mixed && shouldRetryLegacyActionDecision(blockedTools, priorContext) && !actionDecisionRetryRequested) {
          await options.onDiagnostic?.({ stage: 'agent', event: 'retry', runId, iteration, decisionKind: 'legacy_action_decision_required', validationErrors: blockedTools });
          actionDecisionRetryRequested = true;
          validationFailureFallback = { kind: 'blocked', message: '그 작업은 자동 실행할 수 없어요... 아무 작업도 실행하지 않았어요.', blockedTools };
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
    const userVoice = options.userVoiceChannel
      ? `<#${options.userVoiceChannel.id}>${options.userVoiceChannel.name ? ` (${options.userVoiceChannel.name})` : ''}`
      : '(사용자가 음성 채널에 없음)';
    const system = truncate([
      '너는 Discord 봇 ChococoBot의 bounded agent runtime이에요.',
      '사용자 요청은 현재 프리픽스 뒤에 ?로 들어온 AI 요청이에요.',
      '반드시 JSON 객체 하나만 출력하세요. 마크다운, 코드펜스, 설명 문장은 금지예요.',
      '읽기 전용 도구는 필요한 만큼 여러 번 호출하고, 관찰값을 본 뒤 한국어로 자연스럽게 final을 작성해요.',
      '도구 관찰값으로 답할 때도 ChococoBot 말투를 유지해요. 결과만 딱 끊지 말고, 확인한 내용을 짧게 받아 준 뒤 사용자가 이어 말할 수 있는 한 가지 맥락을 덧붙여요.',
      '사용자에게 보이는 final/unavailable/blocked 문장은 느낌표, 물음표, 이모지 없이 보통 ... 또는 해요로 마무리해요.',
      '도구 관찰값이 있으면 not_handled로 넘기지 말고 관찰값만 근거로 final/unavailable/blocked 중 하나로 마무리해요.',
      'web.search 성공 관찰값이 있으면 같은 요청에서 web.search를 반복 호출하지 말고 기존 결과로 final을 작성해요.',
      '이전 agent 문맥에 web_search 관찰값이 있고 사용자가 이전 검색/이전 답변/출처/주소를 묻는 후속 질문이라고 AI가 판단하면, 이전 관찰값의 제목과 URL을 근거로 답해요.',
      '삭제/설정/관리/음성 말하기 같은 실행 도구는 임의 agent loop에서 자동 실행하지 않아요.',
      '음성 말하기도 단 하나의 명확한 기존 말 명령이면 blocked가 아니라 legacy_command를 쓰세요. 예: {"kind":"legacy_command","query":"말 안녕"}',
      '사용자가 "음성 채널에 들어와서 X라고 말해"처럼 입장과 말하기를 함께 요청하고 말할 내용 X가 명확하면 {"kind":"legacy_command","query":"말 X"}를 사용해요. 기존 말 명령은 필요하면 먼저 사용자의 음성 채널에 자동 입장해요.',
      '음성 채널에 들어오라는 요청만 명확하면 {"kind":"legacy_command","query":"들어와"}를 사용하고, 말하라는 요청인데 말할 내용이 없으면 clarify로 자연스럽게 물어봐요.',
      '프리픽스 변경, TTS 채널 설정, 웹 검색 모드 설정, 기억삭제처럼 기존 명령이 있는 단일 실행 요청도 blocked가 아니라 legacy_command로 넘기세요.',
      '읽기 요청과 실행/삭제/설정/음성 요청이 섞여 있으면 blocked로 답하고 아무 것도 실행하지 마세요.',
      '채팅/메시지 삭제 요청에서 그냥 "채팅 3개"처럼 대상이 생략되면 요청자 본인 메시지라고 단정하지 말고 clarify로 누구 채팅인지 물어봐요.',
      '요청자가 "내 채팅/내꺼/내 메시지"라고 명확히 말했거나 이전 clarify 후속으로 본인 것이라고 답한 경우에만 {"kind":"legacy_command","query":"청소 N","cleanupTarget":"self","cleanupEvidence":"내 채팅"}를 사용해요.',
      '특정 다른 사람의 메시지만 지우는 요청은 청소로 처리하지 마세요. 봇은 요청자 본인 메시지 청소 또는 관리자용 채널 전체 대청소만 지원해요.',
      '대청소/전체/채널 전체처럼 채널 메시지 삭제가 명확하면 {"kind":"legacy_command","query":"대청소 N","cleanupTarget":"channel"}를 사용하고 기존 관리자/확인 경로에 맡겨요.',
      '채팅/메시지 삭제 요청에 개수나 대상이 부족하면 clarify로 자연스럽게 되물어봐요.',
      '채팅/메시지 삭제 clarify를 할 때는 AI가 판단한 슬롯 상태를 pendingAction에 함께 넣어요. 예: {"kind":"clarify","message":"누구 채팅을 몇 개 지울까요?","pendingAction":{"kind":"cleanup","originalPrompt":"채팅 지워봐","missing":["target","count"]}}',
      '이전 agent 문맥에 pendingAction이 있으면 현재 짧은 답변(예: 내꺼, 전체, 3개)을 그 pendingAction의 originalPrompt/target/count와 합쳐 legacy_command/clarify/blocked 중 하나로 처리해요.',
      'pendingAction cleanup에서 target은 self/channel/other/ambiguous 중 하나이고, count는 삭제 개수가 명확할 때만 넣어요. 아직 부족한 슬롯은 missing에 남겨요.',
      '대기 중인 확인 작업이 있고 사용자가 그 작업을 승인한다는 의미로 답하면 confirm_pending을 선택해요. 짧은 긍정 답변(예: ㅇ, ㅇㅇ, 응, 네, ok)도 맥락상 승인으로 명확하면 confirm_pending이에요. 승인이 아니면 confirm_pending을 쓰지 마세요.',
      '일반 대화처럼 도구가 필요 없으면 not_handled를 선택해 기존 AI 채팅으로 넘겨요.',
      '허용 출력:',
      '{"kind":"tool_calls","calls":[{"id":"call_1","tool":"time.in_zone","input":{"timeZone":"America/New_York","label":"동부","offsetSeconds":0}}]}',
      '{"kind":"final","message":"..."}',
      '{"kind":"clarify","message":"...","pendingAction":{"kind":"cleanup","originalPrompt":"채팅 지워봐","target":"channel","missing":["count"]}}',
      '{"kind":"unavailable","message":"..."}',
      '{"kind":"unavailable","reason":"web_search_unavailable","message":"..."}',
      '{"kind":"blocked","message":"...","blockedTools":["command.cleanup","voice.speak"]}',
      '{"kind":"legacy_command","query":"말 안녕"}',
      '{"kind":"legacy_command","query":"청소 3","cleanupTarget":"self","cleanupEvidence":"내 채팅"}',
      '{"kind":"legacy_command","query":"대청소 3","cleanupTarget":"channel"}',
      '{"kind":"confirm_pending"}',
      '{"kind":"not_handled"}',
      '미국 시간대 질문은 최소 Eastern/Central/Mountain/Pacific을 각각 time.in_zone으로 호출해요. IANA: America/New_York, America/Chicago, America/Denver, America/Los_Angeles.',
      '이전 맥락이 시간대 목록이면 "그 4군데" 같은 후속 요청에 같은 timeZone 슬롯을 재사용해요.',
      '대화 내용/기록/찾아봐/검색/요약 요청은 history.search를 사용해요. 서버 전체면 scope=server, 채널 지정이면 scope=channel과 channelRef를 넣어요.',
      '특정 주제 없이 최근 대화/대화 내용 자체를 요약하라는 요청이면 history.search mode=summary에서 query=""를 사용해요. "최근 대화" 같은 가짜 검색어를 만들지 마세요.',
      'history.search 성공 관찰값이 있으면 같은 요청에서 history.search를 반복 호출하지 말고 기존 evidence로 final을 작성해요.',
      formatWebSearchPolicy(options.webSearch),
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
      options.pendingConfirmation ? `대기 중인 확인 작업 JSON: ${JSON.stringify(options.pendingConfirmation)}` : undefined,
      priorContext ? `이전 agent 문맥 JSON: ${JSON.stringify(sanitizePriorContextForPrompt(priorContext)).slice(0, 1200)}` : undefined,
      observations.length ? `도구 관찰 JSON: ${formatObservationsForPrompt(observations)}` : undefined,
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
    nowMs: number,
    priorContext: AgentTurnStoredContext | undefined
  ): void {
    if (envelope.kind === 'not_handled' || envelope.kind === 'legacy_command' || envelope.kind === 'confirm_pending' || (envelope.kind === 'final' && calls.length === 0)) {
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




type CleanupValidationResult = { ok: true } | { ok: false; reason: 'cleanup_target_missing' | 'cleanup_target_ambiguous' | 'other_user_cleanup_unsupported' };

function validateLegacyCleanupCommand(
  query: string,
  cleanupTarget: 'self' | 'channel' | 'other' | 'ambiguous' | undefined,
  cleanupEvidence: string | undefined,
  prompt: string,
  priorContext?: AgentTurnStoredContext
): CleanupValidationResult {
  const commandName = query.trim().replace(/^[!?.~]\s*/, '').split(/\s+/)[0]?.toLowerCase();
  if (['청소', 'clean', 'clean-mine', 'clear', '내청소'].includes(commandName ?? '')) {
    if (cleanupTarget === 'self') {
      return hasQuotedCleanupEvidence(cleanupEvidence, prompt, priorContext)
        ? { ok: true }
        : { ok: false, reason: 'cleanup_target_ambiguous' };
    }
    if (cleanupTarget === 'other') return { ok: false, reason: 'other_user_cleanup_unsupported' };
    if (cleanupTarget === 'ambiguous') return { ok: false, reason: 'cleanup_target_ambiguous' };
    return { ok: false, reason: 'cleanup_target_missing' };
  }
  if (['대청소', 'clean-all', 'purge', 'bulk-clear'].includes(commandName ?? '')) {
    if (cleanupTarget === undefined || cleanupTarget === 'channel') return { ok: true };
    return { ok: false, reason: 'cleanup_target_ambiguous' };
  }
  return { ok: true };
}

function hasQuotedCleanupEvidence(cleanupEvidence: string | undefined, prompt: string, priorContext?: AgentTurnStoredContext): boolean {
  const evidence = cleanupEvidence?.trim();
  if (!evidence) return false;
  return [prompt, priorContext?.lastUserPrompt, priorContext?.lastAgentMessage]
    .concat(priorContext?.pendingAction?.originalPrompt ? [priorContext.pendingAction.originalPrompt] : [])
    .filter((value): value is string => Boolean(value))
    .some((value) => value.includes(evidence));
}

function buildCleanupTargetFeedback(reason: 'cleanup_target_missing' | 'cleanup_target_ambiguous' | 'other_user_cleanup_unsupported', priorContext: AgentTurnStoredContext | undefined, displayName?: string): string {
  return [
    reason === 'other_user_cleanup_unsupported'
      ? '방금 legacy_command가 특정 다른 사람 메시지 삭제를 청소로 처리하려 했어요. 특정 다른 사람 메시지만 지우는 기능은 지원하지 않아요.'
      : '방금 cleanup legacy_command에 안전한 cleanupTarget 판단이 없거나 모호했어요.',
    '사용자 의미를 다시 판단해서, 요청자 본인 메시지 삭제가 명확하면 cleanupTarget=self, cleanupEvidence와 함께 청소 N을 내세요. cleanupEvidence는 사용자 말이나 이전 clarify 후속에서 본인 메시지임을 드러내는 원문 일부를 그대로 복사해야 해요. 그런 원문 근거가 없으면 cleanupTarget=self를 쓰지 말고 clarify하세요.',
    '채널 전체 삭제가 명확하면 cleanupTarget=channel과 함께 대청소 N을 내세요.',
    '대상이 불명확하면 legacy_command를 내지 말고 clarify JSON으로 누구 채팅을 지울지 자연스럽게 물어보세요.',
    '특정 다른 사람 메시지만 지우는 요청이면 blocked JSON으로 지원하지 않는다고 안내하세요.',
    priorContext?.lastUserPrompt ? `이전 사용자 요청: ${priorContext.lastUserPrompt}` : undefined,
    priorContext?.lastAgentMessage ? `이전 clarify 질문: ${priorContext.lastAgentMessage}` : undefined,
    displayName ? `요청자 표시 이름은 ${displayName}예요.` : undefined
  ].filter(Boolean).join('\n');
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
    '현재 답변과 이전 pendingAction/originalPrompt를 합쳐 명확해졌다면 legacy_command JSON을 작성하세요.',
    '현재 답변이 봇/다른 사람/지원하지 않는 대상의 메시지를 지우라는 의미라면 blocked JSON으로 "요청자 본인 메시지 삭제 또는 관리자용 전체 채널 삭제만 가능하다"고 자연스럽게 답하세요.',
    '아직 부족하면 업데이트된 pendingAction을 포함한 clarify JSON으로 추가 질문하세요. pendingAction이 남아 있는 동안에는 일반 대화가 아니라 삭제 후속 답변으로 우선 처리하고, not_handled는 쓰지 마세요.'
  ].filter(Boolean).join('\n');
}

function shouldRetryLegacyActionDecision(blockedTools: readonly string[], priorContext?: AgentTurnStoredContext): boolean {
  if (priorContext?.pendingAction && blockedTools.includes('command.cleanup')) return false;
  return blockedTools.some((tool) => LEGACY_ACTION_TOOL_NAMES.has(tool));
}

const LEGACY_ACTION_TOOL_NAMES = new Set([
  'voice.speak',
  'command.cleanup',
  'command.mass_cleanup',
  'settings.prefix',
  'settings.tts_channel',
  'settings.web_search',
  'memory.delete'
]);

function buildLegacyActionDecisionFeedback(blockedTools: readonly string[], displayName?: string): string {
  return [
    `이전 응답은 ${blockedTools.join(', ')}를 blocked/tool_calls로 처리했지만, 기존 prefix 명령으로 넘길 수 있는 단일 실행 요청일 수 있어요.`,
    '사용자 요청을 직접 다시 판단하세요. 명확한 단일 기존 명령이면 legacy_command JSON을 작성하고 query는 지원 prefix 명령 목록의 명령/별칭과 인자를 사용해 직접 생성하세요.',
    '음성 채널에 들어와서 어떤 문장을 말하라는 요청은 "들어와"와 "말"을 따로 내지 말고, 자동 입장 가능한 기존 "말 <문장>" 명령 하나로 표현하세요.',
    '말할 문장이 없고 그냥 말하라는 요청이면 legacy_command를 만들지 말고 clarify로 무슨 말을 할지 물어보세요.',
    '채팅/메시지 삭제에서 대상이 생략되면 요청자 본인 메시지라고 단정하지 마세요. 본인 대상임을 보여주는 사용자 원문 일부를 cleanupEvidence로 그대로 복사할 수 있을 때만 cleanupTarget=self와 함께 청소 N을 사용하고, 그냥 채팅 N개는 clarify로 누구 채팅인지 물어보세요.',
    '특정 다른 사람 메시지만 지우는 요청은 지원하지 않아요. 요청자 본인 청소 또는 관리자용 대청소만 가능하다고 안내하세요. 대청소는 cleanupTarget=channel을 넣으세요.',
    '읽기 요청과 실행 요청이 섞였거나 기존 명령으로 안전하게 표현할 수 없으면 blocked JSON으로 답하세요.',
    '비자동 도구를 tool_calls로 다시 호출하지 마세요.',
    displayName ? `요청자 표시 이름은 ${displayName}예요. 필요하면 clarify 문장에 반영하세요.` : undefined
  ].filter(Boolean).join('\n');
}

function parsePendingAction(raw: unknown): AgentPendingAction | undefined {
  if (!isRecord(raw) || raw.kind !== 'cleanup') return undefined;
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
  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter((item): item is AgentPendingAction['missing'][number] => item === 'target' || item === 'count')
    : [];
  return {
    kind: 'cleanup',
    originalPrompt,
    ...(target ? { target } : {}),
    ...(count ? { count } : {}),
    ...(cleanupEvidence ? { cleanupEvidence } : {}),
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
      return { ok: true, envelope: pendingAction ? { kind, message, pendingAction } : { kind, message } };
    }
    case 'blocked': {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const blockedTools = Array.isArray(parsed.blockedTools) ? parsed.blockedTools.filter((item): item is string => typeof item === 'string') : [];
      if (!message) return { ok: false, errors: ['blocked.message must be non-empty'] };
      return { ok: true, envelope: { kind: 'blocked', message, blockedTools } };
    }
    case 'legacy_command': {
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
      const cleanupTarget = parsed.cleanupTarget === 'self' || parsed.cleanupTarget === 'channel' || parsed.cleanupTarget === 'other' || parsed.cleanupTarget === 'ambiguous'
        ? parsed.cleanupTarget
        : undefined;
      const cleanupEvidence = typeof parsed.cleanupEvidence === 'string' && parsed.cleanupEvidence.trim()
        ? parsed.cleanupEvidence.trim()
        : undefined;
      if (!query) return { ok: false, errors: ['legacy_command.query must be non-empty'] };
      const envelope: AgentEnvelope = cleanupTarget
        ? { kind: 'legacy_command', query, cleanupTarget, ...(cleanupEvidence ? { cleanupEvidence } : {}) }
        : { kind: 'legacy_command', query };
      return { ok: true, envelope };
    }
    case 'confirm_pending':
      return { ok: true, envelope: { kind: 'confirm_pending' } };
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
    output: observation.output,
    error: observation.error
  };
}

function inferIntent(calls: readonly AgentToolCall[], envelope: AgentEnvelope): string | undefined {
  if (calls.some((call) => call.tool.startsWith('time.'))) return 'time';
  if (calls.some((call) => call.tool.startsWith('history.'))) return 'history';
  if (calls.some((call) => call.tool === 'web.search')) return 'web_search';
  if (envelope.kind === 'unavailable' && envelope.reason === 'web_search_unavailable') return 'web_search';
  return envelope.kind;
}

function formatWebSearchPolicy(webSearch: AgentRuntimeOptions['webSearch']): string {
  if (!webSearch) return '웹 검색 설정: unavailable. web.search를 호출하지 말고 일반 대화면 not_handled, 검색이 필요한 요청이면 unavailable로 답해요.';
  const statusText = `웹 검색 설정: mode=${webSearch.mode}, provider=${webSearch.provider}, providerStatus=${webSearch.providerStatus}, resultCount=${webSearch.resultCount}.`;
  const shared = [
    statusText,
    'web.search는 공개 웹의 최신/외부/검증 가능한 정보를 확인하는 읽기 전용 도구예요. Discord 서버 대화 기록은 web.search가 아니라 history.search를 사용해요.',
    '잡담, 창작, 의견 요청, 서버 대화 기록만 필요한 요청에는 web.search를 호출하지 마세요.',
    'web.search 관찰값을 근거로 답하면 문장 끝이나 문단 끝에 [1], [2]처럼 결과 번호를 붙이고, 답변 아래에 출처: [1] 제목 — URL 형식으로 간단히 적어요.',
    'web.search가 error이거나 providerStatus가 ready가 아니고 현재 사용자 요청을 AI가 웹검색 필요 요청으로 판단했다면 검색 없이 사실 답을 꾸미지 말고 {"kind":"unavailable","reason":"web_search_unavailable","message":"..."} JSON으로 웹 검색을 사용할 수 없다고 한국어로 설명해요.'
  ];
  if (webSearch.mode === 'disabled') {
    return [...shared, '현재 서버 웹 검색 모드는 disabled예요. web.search를 호출하지 마세요. 명시적 검색 요청이면 unavailable로 답해요.'].join('\n');
  }
  if (webSearch.providerStatus !== 'ready') {
    return [...shared, `현재 providerStatus가 ${webSearch.providerStatus}라 web.search를 호출해도 실패할 수 있어요. 명시적 검색/사실 확인 요청이면 unavailable로 답해요.`].join('\n');
  }
  if (webSearch.mode === 'explicit_only') {
    return [...shared, '현재 모드는 explicit_only예요. 사용자가 웹 검색/인터넷 검색/최신 확인/출처 확인을 명시한 경우에만 web.search를 호출해요.'].join('\n');
  }
  if (webSearch.mode === 'automatic') {
    return [...shared, '현재 모드는 automatic이에요. 최신성/외부 사실/불확실성이 답 품질에 중요할 때 web.search를 호출해요.'].join('\n');
  }
  return [...shared, '현재 모드는 search_first_factual이에요. 최신/외부/검증 가능한 사실 질문은 가능한 먼저 web.search를 호출한 뒤 답해요.'].join('\n');
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

function hasUsableObservation(observations: readonly AgentToolObservation[]): boolean {
  return hasSuccessfulWebSearchObservation(observations) || hasSuccessfulHistorySearchObservation(observations);
}

function hasSuccessfulWebSearchObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulWebSearchSources(observations).length > 0;
}

function hasSuccessfulHistorySearchObservation(observations: readonly AgentToolObservation[]): boolean {
  return extractSuccessfulHistoryEvidence(observations).length > 0;
}

function buildExistingWebSearchObservationFeedback(observations: readonly AgentToolObservation[]): string {
  const sources = extractSuccessfulWebSearchSources(observations);
  return [
    '이미 web.search 성공 관찰값이 있어요.',
    '같은 요청에서 web.search를 다시 호출하지 말고, 아래 출처와 현재 도구 관찰 JSON만 근거로 final JSON을 작성하세요.',
    '확실하지 않은 내용은 단정하지 말고 "검색 결과 기준"이라고 밝혀요.',
    '출처:',
    ...sources.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`)
  ].join('\n');
}

function buildExistingHistorySearchObservationFeedback(observations: readonly AgentToolObservation[]): string {
  const evidence = extractSuccessfulHistoryEvidence(observations);
  return [
    '이미 history.search 성공 관찰값이 있어요.',
    '같은 요청에서 history.search를 다시 호출하지 말고, 아래 대화 증거와 현재 도구 관찰 JSON만 근거로 final JSON을 작성하세요.',
    '요약이면 주요 흐름을 짧게 정리하고, 정보가 적으면 "읽은 메시지 기준"이라고 밝혀요.',
    ...formatHistoryEvidenceForFeedback(evidence)
  ].join('\n');
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
      '대화 기록은 읽었는데 답변 정리를 끝내지 못했어요...',
      '읽은 메시지 기준으로는 이런 흐름이에요...',
      ...evidence.slice(0, 6).map((item) => `- ${item.authorName}: ${truncate(item.content.replace(/\s+/g, ' '), 120)}`)
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
  if (!isRecord(observation.output)) {
    return {
      callId: observation.callId,
      toolName: observation.toolName,
      status: observation.status,
      policy: observation.policy,
      error: observation.error
    };
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
    callId: observation.callId,
    toolName: observation.toolName,
    status: observation.status,
    policy: observation.policy,
    output: {
      provider: observation.output.provider,
      results
    },
    error: observation.error
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
