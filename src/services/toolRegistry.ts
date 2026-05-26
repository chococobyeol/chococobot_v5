export type AgentToolPolicy = 'read_only_auto' | 'safe_action_auto' | 'legacy_single_action' | 'confirmation_required' | 'blocked';

export type AgentToolDefinition<I = unknown, O = unknown> = {
  name: string;
  description: string;
  inputSchema: string;
  policy: AgentToolPolicy;
  retryable: boolean;
  logFields?: readonly string[];
  validate(input: unknown): { ok: true; value: I } | { ok: false; errors: string[] };
  execute(input: I, context: AgentToolExecutionContext): Promise<O>;
};

export type AgentDiscordPresentation = {
  title?: string;
  summary?: string;
  files?: Array<{ path: string; name: string }>;
  cards?: Array<{ selectionNumber: number; name: string; orientation: string; attachmentName?: string }>;
};

export type AgentToolRuntimeContext = {
  prefix?: string;
  currentChannelId?: string;
  requesterDisplayName?: string;
  availableChannels?: readonly { id: string; name: string; mention: string }[];
  /** Requester voice channel only; this must not be treated as the bot location. */
  userVoiceChannel?: { id: string; name?: string | null } | null;
  /** Source of truth for whether the bot is currently in voice. */
  botVoiceConnected?: boolean;
  /** Source of truth for the bot voice-channel location when connected. */
  botVoiceChannel?: { id: string; name?: string | null } | null;
  voiceSemantics?: {
    userVoice: 'requester_voice_channel_not_bot_location';
    botVoice: 'botVoiceConnected_and_botVoiceChannel_are_bot_location_source_of_truth';
  };
  webSearch?: { mode: string; provider: string; providerStatus: string; resultCount: number };
  tarotPending?: { topic: string; spreadCount: number; spreadName?: string; expiresAt?: number; requesterDisplayName?: string };
};

export type AgentToolExecutionContext = {
  nowMs: number;
  message?: unknown;
  botContext?: unknown;
  runtime?: AgentToolRuntimeContext;
};

export class AgentToolExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint: string,
    public readonly status: AgentToolObservation['status'] = 'error',
    public readonly field?: string
  ) {
    super(message);
    this.name = 'AgentToolExecutionError';
  }
}

export type AgentToolObservation = {
  callId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked' | 'confirmation_required';
  policy: AgentToolPolicy;
  code?: string;
  field?: string;
  message?: string;
  hint?: string;
  output?: unknown;
  error?: string;
  confirmation?: {
    intent: string;
    preview: string;
    payload?: unknown;
    commandQuery?: string;
    expiresAt?: number;
  };
};

export type HistorySearchInput = {
  scope: 'server' | 'channel';
  channelRef?: string;
  /** Empty query is allowed for summary mode to retrieve recent conversation without keyword filtering. */
  query: string;
  mode: 'qa' | 'summary';
  limit?: number;
};

export type HistorySearchOutput = {
  scope: string;
  channelId?: string;
  query: string;
  scannedChannels: number;
  matchedMessages: number;
  usedMessages: number;
  evidence: Array<{ channelId: string; authorName: string; timestamp: string; content: string }>;
};

export type HistorySummarizeInput = {
  searchRef?: string;
  messages?: unknown[];
  query: string;
  mode: 'qa' | 'summary';
};

export type WebSearchInput = {
  query: string;
  count?: number;
  language?: string;
  freshness?: string;
};

export type WebSearchOutput = {
  provider: 'searxng';
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet?: string;
    sourceDomain?: string;
    publishedAt?: string;
  }>;
};


export type TarotStartReadingInput = {
  topic: string;
  spreadCount: number;
  spreadName?: string;
};

export type TarotStartReadingOutput = {
  sessionId?: string;
  topic: string;
  spreadCount: number;
  spreadName?: string;
  selection?: { min: number; max: number; count: number; unique: boolean };
  responseInstruction?: string;
  expiresAt?: number;
};

export type TarotRevealSelectionInput = {
  numbers: number[];
};

export type TarotRevealSelectionOutput = {
  message: string;
  interpretationInstruction?: string;
  topic?: string;
  spreadCount?: number;
  selectedNumbers?: number[];
  cards?: unknown[];
  visualData?: { bars?: string; [key: string]: unknown };
  presentation?: AgentDiscordPresentation;
};

export type TarotCancelReadingOutput = {
  message: string;
  cancelled: boolean;
};

export type VoiceJoinOutput = {
  message: string;
  channelId?: string;
};

export type VoiceLeaveOutput = {
  message: string;
};

export type VoiceStopOutput = {
  message: string;
  stopped: boolean;
};

export type VoiceSpeakInput = {
  text: string;
};

export type VoiceSpeakOutput = {
  message: string;
  text: string;
  autoJoined: boolean;
  channelId?: string;
};

export type TtsVoicePresetInput = {
  action: 'status' | 'set';
  preset?: string;
};

export type TtsVoicePresetOutput = {
  message: string;
  current?: string;
  available: string[];
};

export type TtsEngineInput = {
  action: 'status' | 'set' | 'clear';
  engine?: string;
};

export type TtsEngineOutput = {
  message: string;
  current?: string;
  available: string[];
};

export type UserTimezoneInput = {
  action: 'status' | 'set' | 'clear';
  timeZone?: string;
};

export type UserTimezoneOutput = {
  message: string;
  current?: string;
  defaultTimeZone: string;
};

export type ToolRegistryHandlers = {
  historySearch?: (input: HistorySearchInput, context: AgentToolExecutionContext) => Promise<HistorySearchOutput>;
  historySummarize?: (input: HistorySummarizeInput, context: AgentToolExecutionContext) => Promise<{ message: string }>;
  webSearch?: (input: WebSearchInput, context: AgentToolExecutionContext) => Promise<WebSearchOutput>;
  voiceJoin?: (input: Record<string, never>, context: AgentToolExecutionContext) => Promise<VoiceJoinOutput>;
  voiceLeave?: (input: Record<string, never>, context: AgentToolExecutionContext) => Promise<VoiceLeaveOutput>;
  voiceStop?: (input: Record<string, never>, context: AgentToolExecutionContext) => Promise<VoiceStopOutput>;
  voiceSpeak?: (input: VoiceSpeakInput, context: AgentToolExecutionContext) => Promise<VoiceSpeakOutput>;
  ttsVoicePreset?: (input: TtsVoicePresetInput, context: AgentToolExecutionContext) => Promise<TtsVoicePresetOutput>;
  ttsEngine?: (input: TtsEngineInput, context: AgentToolExecutionContext) => Promise<TtsEngineOutput>;
  userTimezone?: (input: UserTimezoneInput, context: AgentToolExecutionContext) => Promise<UserTimezoneOutput>;
  tarotStartReading?: (input: TarotStartReadingInput, context: AgentToolExecutionContext) => Promise<TarotStartReadingOutput>;
  tarotRevealSelection?: (input: TarotRevealSelectionInput, context: AgentToolExecutionContext) => Promise<TarotRevealSelectionOutput>;
  tarotCancelReading?: (input: Record<string, never>, context: AgentToolExecutionContext) => Promise<TarotCancelReadingOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  constructor(definitions: readonly AgentToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: AgentToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): AgentToolDefinition[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(name: string, input: unknown, context: AgentToolExecutionContext): Promise<AgentToolObservation> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        callId: '',
        toolName: name,
        status: 'error',
        policy: 'blocked',
        code: 'unknown_tool',
        message: `Unknown tool: ${name}`,
        hint: 'Use one of the registered tool names from the runtime tool list.',
        error: `Unknown tool: ${name}`
      };
    }
    const validated = tool.validate(input);
    if (!validated.ok) {
      const detail = describeValidationErrors(validated.errors);
      return {
        callId: '',
        toolName: name,
        status: 'error',
        policy: tool.policy,
        code: detail.code,
        field: detail.field,
        message: detail.message,
        hint: detail.hint,
        error: detail.message
      };
    }
    if (!isAutoExecutablePolicy(tool.policy)) {
      if (tool.policy === 'confirmation_required') {
        return {
          callId: '',
          toolName: name,
          status: 'confirmation_required',
          policy: tool.policy,
          code: 'confirmation_required',
          message: `Tool ${name} requires confirmation before execution.`,
          hint: 'Return this confirmation preview to the user and execute only after a structured confirmation outcome.',
          confirmation: buildConfirmation(name, validated.value)
        };
      }
      return {
        callId: '',
        toolName: name,
        status: 'blocked',
        policy: tool.policy,
        code: 'policy_blocked',
        message: `Tool policy ${tool.policy} is not auto-executable`,
        hint: 'Do not execute this tool from the automatic agent loop; explain the block or use the supported confirmation/command path.',
        error: `Tool policy ${tool.policy} is not auto-executable`
      };
    }
    try {
      return { callId: '', toolName: name, status: 'ok', policy: tool.policy, output: await tool.execute(validated.value, context) };
    } catch (error) {
      if (error instanceof AgentToolExecutionError) {
        return {
          callId: '',
          toolName: name,
          status: error.status,
          policy: tool.policy,
          code: error.code,
          ...(error.field ? { field: error.field } : {}),
          message: error.message,
          hint: error.hint,
          error: error.message
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        callId: '',
        toolName: name,
        status: 'error',
        policy: tool.policy,
        code: 'tool_unavailable',
        message,
        hint: 'Use an unavailable/fallback answer grounded in the failed observation; do not invent tool output.',
        error: message
      };
    }
  }
}

function isAutoExecutablePolicy(policy: AgentToolPolicy): boolean {
  return policy === 'read_only_auto' || policy === 'safe_action_auto';
}

function describeValidationErrors(errors: readonly string[]): { code: string; field?: string; message: string; hint: string } {
  const message = errors.join('; ') || 'Tool input validation failed';
  const first = errors[0] ?? '';
  const field = first.match(/^([A-Za-z0-9_.-]+)\s+(?:must|is|required|may)/)?.[1]
    ?? first.match(/^([A-Za-z0-9_.-]+)\s+is\s+required/)?.[1];
  return {
    code: 'validation_error',
    ...(field ? { field } : {}),
    message,
    hint: field
      ? `Fix the structured input field "${field}" according to the tool schema, then retry only if the request still needs the tool.`
      : 'Fix the structured input according to the tool schema, then retry only if the request still needs the tool.'
  };
}

function buildConfirmation(toolName: string, payload: unknown): NonNullable<AgentToolObservation['confirmation']> {
  return {
    intent: toolName,
    preview: `Confirm ${toolName}`,
    payload,
    commandQuery: inferCommandQuery(toolName, payload)
  };
}

function inferCommandQuery(toolName: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (toolName === 'command.cleanup') return `청소${typeof payload.count === 'number' ? ` ${payload.count}` : ''}`;
  if (toolName === 'command.mass_cleanup') return `대청소${typeof payload.count === 'number' ? ` ${payload.count}` : ''}`;
  if (toolName === 'settings.prefix') {
    if (payload.action === 'reset') return '프리픽스 기본';
    if (typeof payload.prefix === 'string') return `프리픽스 ${payload.prefix}`;
  }
  if (toolName === 'settings.tts_channel') {
    if (payload.action === 'clear') return 'tts채널 해제';
    if (typeof payload.channelRef === 'string') return `tts채널 ${payload.channelRef}`;
    return 'tts채널';
  }
  if (toolName === 'settings.ai_channel') {
    if (payload.action === 'clear') return 'ai채널 해제';
    if (typeof payload.channelRef === 'string') return `ai채널 ${payload.channelRef}`;
    return 'ai채널';
  }
  if (toolName === 'settings.web_search' && typeof payload.mode === 'string') {
    return payload.mode === 'default' ? '웹검색 초기화' : `웹검색 ${payload.mode}`;
  }
  if (toolName === 'memory.delete') return '기억삭제';
  return undefined;
}

export function createDefaultToolRegistry(handlers: ToolRegistryHandlers = {}): ToolRegistry {
  return new ToolRegistry([
    runtimeContextTool(),
    timeViewerTool(),
    timeInZoneTool(),
    historySearchTool(handlers),
    historySummarizeTool(handlers),
    webSearchTool(handlers),
    voiceJoinTool(handlers),
    voiceLeaveTool(handlers),
    voiceStopTool(handlers),
    voiceSpeakTool(handlers),
    ttsVoicePresetTool(handlers),
    ttsEngineTool(handlers),
    userTimezoneTool(handlers),
    tarotStartReadingTool(handlers),
    tarotRevealSelectionTool(handlers),
    tarotCancelReadingTool(handlers),
    cleanupTool(),
    massCleanupTool(),
    prefixSettingsTool(),
    ttsChannelSettingsTool(),
    aiChannelSettingsTool(),
    webSearchSettingsTool(),
    memoryDeleteTool(),
    blockedTool('admin.log_management', 'Manage bot logging channels.')
  ]);
}

function runtimeContextTool(): AgentToolDefinition<Record<string, never>, { now: number; context?: AgentToolRuntimeContext }> {
  return {
    name: 'runtime.context',
    description: 'Read compact runtime context. userVoiceChannel is requester-only; botVoiceConnected/botVoiceChannel are the bot voice-location source of truth.',
    inputSchema: '{}',
    policy: 'read_only_auto',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      if (Object.keys(input).length) return { ok: false, errors: ['input must be empty'] };
      return { ok: true, value: {} };
    },
    async execute(_input, context) {
      return { now: context.nowMs, context: context.runtime };
    }
  };
}

function timeViewerTool(): AgentToolDefinition<{ offsetSeconds?: number }, { display: string; epochSeconds: number; timestampTag: string }> {
  return {
    name: 'time.viewer',
    description: 'Return a Discord timestamp that displays in each viewer local time.',
    inputSchema: '{ offsetSeconds?: number }',
    policy: 'read_only_auto',
    retryable: false,
    logFields: ['offsetSeconds'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const offsetSeconds = optionalInteger(input.offsetSeconds, 'offsetSeconds');
      if (!offsetSeconds.ok) return offsetSeconds;
      return { ok: true, value: { offsetSeconds: offsetSeconds.value } };
    },
    async execute(input, context) {
      const epochSeconds = Math.floor((context.nowMs + (input.offsetSeconds ?? 0) * 1_000) / 1_000);
      const timestampTag = `<t:${epochSeconds}:t>`;
      return { display: timestampTag, epochSeconds, timestampTag };
    }
  };
}

function timeInZoneTool(): AgentToolDefinition<{ timeZone: string; label?: string; offsetSeconds?: number }, { label: string; timeZone: string; display: string; iso: string; epochSeconds: number }> {
  return {
    name: 'time.in_zone',
    description: 'Return current time in a named IANA time zone.',
    inputSchema: '{ timeZone: string; label?: string; offsetSeconds?: number }',
    policy: 'read_only_auto',
    retryable: false,
    logFields: ['timeZone', 'label', 'offsetSeconds'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const timeZone = stringField(input.timeZone, 'timeZone');
      const label = optionalString(input.label, 'label');
      const offsetSeconds = optionalInteger(input.offsetSeconds, 'offsetSeconds');
      const errors = [...timeZone.errors, ...label.errors, ...offsetSeconds.errors];
      if (timeZone.value && !isValidTimeZone(timeZone.value)) errors.push('timeZone must be a valid IANA time zone');
      const offsetValue = offsetSeconds.ok ? offsetSeconds.value : undefined;
      if (errors.length) return { ok: false, errors };
      return { ok: true, value: { timeZone: timeZone.value!, label: label.value, offsetSeconds: offsetValue } };
    },
    async execute(input, context) {
      const date = new Date(context.nowMs + (input.offsetSeconds ?? 0) * 1_000);
      return {
        label: input.label || input.timeZone,
        timeZone: input.timeZone,
        display: formatTimeInZone(date, input.timeZone),
        iso: date.toISOString(),
        epochSeconds: Math.floor(date.getTime() / 1_000)
      };
    }
  };
}

function historySearchTool(handlers: ToolRegistryHandlers): AgentToolDefinition<HistorySearchInput, HistorySearchOutput> {
  return {
    name: 'history.search',
    description: 'Search or retrieve Discord channel/server history with existing permission and range checks.',
    inputSchema: "{ scope: 'server'|'channel'; channelRef?: string; query: string; mode: 'qa'|'summary'; limit?: number } // query may be empty only when mode='summary' to summarize recent conversation",
    policy: 'read_only_auto',
    retryable: true,
    logFields: ['scope', 'channelRef', 'query', 'mode', 'limit'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const errors: string[] = [];
      const scope = input.scope === 'server' || input.scope === 'channel' ? input.scope : undefined;
      const mode = input.mode === 'qa' || input.mode === 'summary' ? input.mode : undefined;
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      const channelRef = typeof input.channelRef === 'string' ? input.channelRef.trim() : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      if (!scope) errors.push('scope must be server or channel');
      if (!mode) errors.push('mode must be qa or summary');
      if (!query && mode !== 'summary') errors.push('query must be a non-empty string unless mode is summary');
      if (scope === 'channel' && !channelRef) errors.push('channelRef is required for channel scope');
      if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) errors.push('limit must be an integer from 1 to 500');
      if (errors.length || !scope || !mode) return { ok: false, errors };
      return { ok: true, value: { scope, mode, query, channelRef, limit } };
    },
    async execute(input, context) {
      if (!handlers.historySearch) throw new Error('history.search is unavailable in this runtime');
      return handlers.historySearch(input, context);
    }
  };
}

function webSearchTool(handlers: ToolRegistryHandlers): AgentToolDefinition<WebSearchInput, WebSearchOutput> {
  return {
    name: 'web.search',
    description: 'Search the public web for current, external, or fact-checkable information and return concise cited results.',
    inputSchema: '{ query: string; count?: number; language?: string; freshness?: string }',
    policy: 'read_only_auto',
    retryable: true,
    logFields: ['query', 'count', 'language', 'freshness'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      const count = typeof input.count === 'number' ? input.count : undefined;
      const language = typeof input.language === 'string' ? input.language.trim() : undefined;
      const freshness = typeof input.freshness === 'string' ? input.freshness.trim() : undefined;
      const errors: string[] = [];
      if (!query) errors.push('query must be a non-empty string');
      if (input.count !== undefined && (typeof input.count !== 'number' || !Number.isInteger(input.count) || input.count < 1 || input.count > 10)) errors.push('count must be an integer from 1 to 10');
      if (errors.length) return { ok: false, errors };
      return { ok: true, value: { query, count, language, freshness } };
    },
    async execute(input, context) {
      if (!handlers.webSearch) throw new Error('web.search is unavailable in this runtime');
      return handlers.webSearch(input, context);
    }
  };
}

function historySummarizeTool(handlers: ToolRegistryHandlers): AgentToolDefinition<HistorySummarizeInput, { message: string }> {
  return {
    name: 'history.summarize',
    description: 'Answer or summarize from provided history observations.',
    inputSchema: "{ searchRef?: string; messages?: unknown[]; query: string; mode: 'qa'|'summary' }",
    policy: 'read_only_auto',
    retryable: true,
    logFields: ['searchRef', 'query', 'mode'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const mode = input.mode === 'qa' || input.mode === 'summary' ? input.mode : undefined;
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      const searchRef = typeof input.searchRef === 'string' ? input.searchRef.trim() : undefined;
      const messages = Array.isArray(input.messages) ? input.messages : undefined;
      const errors: string[] = [];
      if (!mode) errors.push('mode must be qa or summary');
      if (!query) errors.push('query must be a non-empty string');
      if (errors.length || !mode) return { ok: false, errors };
      return { ok: true, value: { mode, query, searchRef, messages } };
    },
    async execute(input, context) {
      if (handlers.historySummarize) return handlers.historySummarize(input, context);
      return { message: 'history.search 관찰 결과를 바탕으로 답변을 작성해 주세요.' };
    }
  };
}

function voiceJoinTool(handlers: ToolRegistryHandlers): AgentToolDefinition<Record<string, never>, VoiceJoinOutput> {
  return {
    name: 'voice.join',
    description: 'Safely connect the bot to the requester voice channel when the user is already in voice.',
    inputSchema: '{}',
    policy: 'safe_action_auto',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      return { ok: true, value: {} };
    },
    async execute(input, context) {
      if (!handlers.voiceJoin) throw new Error('voice.join is unavailable in this runtime');
      return handlers.voiceJoin(input, context);
    }
  };
}

function voiceLeaveTool(handlers: ToolRegistryHandlers): AgentToolDefinition<Record<string, never>, VoiceLeaveOutput> {
  return {
    name: 'voice.leave',
    description: 'Safely disconnect the bot from its current voice channel.',
    inputSchema: '{}',
    policy: 'safe_action_auto',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      return { ok: true, value: {} };
    },
    async execute(input, context) {
      if (!handlers.voiceLeave) throw new Error('voice.leave is unavailable in this runtime');
      return handlers.voiceLeave(input, context);
    }
  };
}

function voiceStopTool(handlers: ToolRegistryHandlers): AgentToolDefinition<Record<string, never>, VoiceStopOutput> {
  return {
    name: 'voice.stop',
    description: 'Safely stop current TTS playback without changing voice-channel connection.',
    inputSchema: '{}',
    policy: 'safe_action_auto',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      if (Object.keys(input).length) return { ok: false, errors: ['input must be empty'] };
      return { ok: true, value: {} };
    },
    async execute(input, context) {
      if (!handlers.voiceStop) throw new Error('voice.stop is unavailable in this runtime');
      return handlers.voiceStop(input, context);
    }
  };
}

function voiceSpeakTool(handlers: ToolRegistryHandlers): AgentToolDefinition<VoiceSpeakInput, VoiceSpeakOutput> {
  return {
    name: 'voice.speak',
    description: 'Safely speak the provided text in the requester voice channel; may auto-join when the bot is not connected.',
    inputSchema: '{ text: string }',
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['text'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const text = stringField(input.text, 'text');
      if (text.errors.length) return { ok: false, errors: text.errors };
      if (text.value && text.value.length > 500) return { ok: false, errors: ['text must be at most 500 characters'] };
      return { ok: true, value: { text: text.value! } };
    },
    async execute(input, context) {
      if (!handlers.voiceSpeak) throw new Error('voice.speak is unavailable in this runtime');
      return handlers.voiceSpeak(input, context);
    }
  };
}

function ttsVoicePresetTool(handlers: ToolRegistryHandlers): AgentToolDefinition<TtsVoicePresetInput, TtsVoicePresetOutput> {
  return {
    name: 'tts.voice_preset',
    description: 'Read or update the requester TTS voice preset.',
    inputSchema: "{ action: 'status'|'set'; preset?: string }",
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['action', 'preset'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const action = input.action === 'status' || input.action === 'set' ? input.action : undefined;
      const errors: string[] = [];
      if (!action) errors.push('action must be status or set');
      const preset = typeof input.preset === 'string' ? input.preset.trim() : undefined;
      if (action === 'set' && !preset) errors.push('preset is required for set action');
      if (errors.length || !action) return { ok: false, errors };
      return { ok: true, value: { action, ...(preset ? { preset } : {}) } };
    },
    async execute(input, context) {
      if (!handlers.ttsVoicePreset) throw new Error('tts.voice_preset is unavailable in this runtime');
      return handlers.ttsVoicePreset(input, context);
    }
  };
}

function ttsEngineTool(handlers: ToolRegistryHandlers): AgentToolDefinition<TtsEngineInput, TtsEngineOutput> {
  return {
    name: 'tts.engine',
    description: 'Read, update, or clear the requester TTS engine preference.',
    inputSchema: "{ action: 'status'|'set'|'clear'; engine?: string }",
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['action', 'engine'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const action = input.action === 'status' || input.action === 'set' || input.action === 'clear' ? input.action : undefined;
      const errors: string[] = [];
      if (!action) errors.push('action must be status, set, or clear');
      const engine = typeof input.engine === 'string' ? input.engine.trim() : undefined;
      if (action === 'set' && !engine) errors.push('engine is required for set action');
      if (errors.length || !action) return { ok: false, errors };
      return { ok: true, value: { action, ...(engine ? { engine } : {}) } };
    },
    async execute(input, context) {
      if (!handlers.ttsEngine) throw new Error('tts.engine is unavailable in this runtime');
      return handlers.ttsEngine(input, context);
    }
  };
}

function userTimezoneTool(handlers: ToolRegistryHandlers): AgentToolDefinition<UserTimezoneInput, UserTimezoneOutput> {
  return {
    name: 'time.user_timezone',
    description: 'Read, update, or clear the requester time-zone preference used for AI time answers.',
    inputSchema: "{ action: 'status'|'set'|'clear'; timeZone?: string }",
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['action', 'timeZone'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const action = input.action === 'status' || input.action === 'set' || input.action === 'clear' ? input.action : undefined;
      const errors: string[] = [];
      if (!action) errors.push('action must be status, set, or clear');
      const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : undefined;
      if (action === 'set' && !timeZone) errors.push('timeZone is required for set action');
      if (timeZone && !isValidTimeZone(timeZone)) errors.push('timeZone must be a valid IANA time zone');
      if (errors.length || !action) return { ok: false, errors };
      return { ok: true, value: { action, ...(timeZone ? { timeZone } : {}) } };
    },
    async execute(input, context) {
      if (!handlers.userTimezone) throw new Error('time.user_timezone is unavailable in this runtime');
      return handlers.userTimezone(input, context);
    }
  };
}


function tarotStartReadingTool(handlers: ToolRegistryHandlers): AgentToolDefinition<TarotStartReadingInput, TarotStartReadingOutput> {
  return {
    name: 'tarot.start_reading',
    description: 'Start a Discord-chat tarot reading after the AI decides the user wants tarot/fortune and chooses a 1-5 card spread. Creates an active card-selection session and asks the requester to pick numbers from 1 to 78.',
    inputSchema: '{ topic: string; spreadCount: integer 1..5; spreadName?: string } // spreadCount: 1=yes/no or single advice, 3=general flow, 5=complex range/cause+caution+action/comparison',
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['topic', 'spreadCount', 'spreadName'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const topic = stringField(input.topic, 'topic');
      const count = boundedInteger(input.spreadCount, 'spreadCount', 1, 5);
      const spreadName = optionalString(input.spreadName, 'spreadName');
      const errors = [...topic.errors, ...count.errors, ...spreadName.errors];
      if (errors.length || !topic.value || count.value === undefined) return { ok: false, errors };
      return { ok: true, value: { topic: topic.value, spreadCount: count.value, ...(spreadName.value ? { spreadName: spreadName.value } : {}) } };
    },
    async execute(input, context) {
      if (!handlers.tarotStartReading) throw new Error('tarot.start_reading is unavailable in this runtime');
      return handlers.tarotStartReading(input, context);
    }
  };
}

function tarotRevealSelectionTool(handlers: ToolRegistryHandlers): AgentToolDefinition<TarotRevealSelectionInput, TarotRevealSelectionOutput> {
  return {
    name: 'tarot.reveal_selection',
    description: 'Reveal cards for an active tarot session from requester-selected unique numbers. Code validates active session, exact count, duplicate numbers, and 1-78 range; AI writes the interpretation only from the observation; if the model fails, runtime returns a safe observation-based fallback.',
    inputSchema: '{ numbers: integer[] } // selected card numbers, unique, 1..78, exact count is checked against active tarotPending session',
    policy: 'safe_action_auto',
    retryable: false,
    logFields: ['numbers'],
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      if (!Array.isArray(input.numbers) || input.numbers.length === 0) return { ok: false, errors: ['numbers must be a non-empty array'] };
      if (input.numbers.some((number) => typeof number !== 'number' || !Number.isInteger(number))) return { ok: false, errors: ['numbers must contain only integers'] };
      return { ok: true, value: { numbers: [...input.numbers] } };
    },
    async execute(input, context) {
      const duplicate = new Set(input.numbers).size !== input.numbers.length;
      if (duplicate) {
        throw new AgentToolExecutionError('duplicate_numbers', '중복된 숫자는 선택할 수 없어요. 서로 다른 번호를 골라주세요.', 'Retry with unique card numbers.', 'error', 'numbers');
      }
      if (input.numbers.some((number) => number < 1 || number > 78)) {
        throw new AgentToolExecutionError('number_out_of_range', '1~78 사이에서 골라주세요.', 'Retry with only integer card numbers from 1 to 78.', 'error', 'numbers');
      }
      if (input.numbers.length > 5) {
        throw new AgentToolExecutionError('wrong_count', '카드는 한 번에 1~5개만 고를 수 있어요.', 'Retry with the exact number requested by the active tarot session.', 'error', 'numbers');
      }
      if (!handlers.tarotRevealSelection) throw new Error('tarot.reveal_selection is unavailable in this runtime');
      return handlers.tarotRevealSelection(input, context);
    }
  };
}

function tarotCancelReadingTool(handlers: ToolRegistryHandlers): AgentToolDefinition<Record<string, never>, TarotCancelReadingOutput> {
  return {
    name: 'tarot.cancel_reading',
    description: 'Cancel the requester active tarot card-selection session when the user declines, stops, or says they do not want to continue.',
    inputSchema: '{}',
    policy: 'safe_action_auto',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      if (Object.keys(input).length > 0) return { ok: false, errors: ['input must be empty'] };
      return { ok: true, value: {} };
    },
    async execute(input, context) {
      if (!handlers.tarotCancelReading) throw new Error('tarot.cancel_reading is unavailable in this runtime');
      return handlers.tarotCancelReading(input, context);
    }
  };
}

function cleanupTool(): AgentToolDefinition<{ target: 'self'; count: number; evidence: string }, never> {
  return {
    name: 'command.cleanup',
    description: 'Request deletion of requester own recent messages. evidence is AI-owned internal safety quote from user text, never a user-facing clarification slot.',
    inputSchema: "{ target: 'self'; count: number; evidence: string } // evidence must be a literal quote from current/stored user text; never ask user for evidence",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const errors: string[] = [];
      const target = input.target === 'self' ? input.target : undefined;
      const count = boundedInteger(input.count, 'count', 1, 500);
      const evidence = stringField(input.evidence, 'evidence');
      if (!target) errors.push('target must be self');
      errors.push(...count.errors, ...evidence.errors);
      if (errors.length || !target || count.value === undefined || !evidence.value) return { ok: false, errors };
      return { ok: true, value: { target, count: count.value, evidence: evidence.value } };
    },
    async execute(): Promise<never> {
      throw new Error('command.cleanup must be confirmed before execution');
    }
  };
}

function massCleanupTool(): AgentToolDefinition<{ target: 'channel'; count: number }, never> {
  return {
    name: 'command.mass_cleanup',
    description: 'Request deletion of recent channel messages. Use for channel-wide cleanup; no evidence field exists, confirmation/admin path checks before execution.',
    inputSchema: "{ target: 'channel'; count: number } // channel-wide cleanup has no evidence field",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const errors: string[] = [];
      const target = input.target === undefined || input.target === 'channel' ? 'channel' : undefined;
      const count = boundedInteger(input.count, 'count', 1, 1000);
      if (!target) errors.push('target must be channel');
      errors.push(...count.errors);
      if (errors.length || count.value === undefined || !target) return { ok: false, errors };
      return { ok: true, value: { target, count: count.value } };
    },
    async execute(): Promise<never> {
      throw new Error('command.mass_cleanup must be confirmed before execution');
    }
  };
}

function prefixSettingsTool(): AgentToolDefinition<{ action: 'set' | 'reset'; prefix?: string }, never> {
  return {
    name: 'settings.prefix',
    description: 'Request a server command prefix change. Requires action=set with prefix, or action=reset.',
    inputSchema: "{ action: 'set'|'reset'; prefix?: string }",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const action = input.action === 'set' || input.action === 'reset' ? input.action : undefined;
      const errors: string[] = [];
      if (!action) errors.push('action must be set or reset');
      if (action === 'set') {
        const prefix = stringField(input.prefix, 'prefix');
        errors.push(...prefix.errors);
        if (errors.length || !prefix.value) return { ok: false, errors };
        return { ok: true, value: { action, prefix: prefix.value } };
      }
      if (errors.length || !action) return { ok: false, errors };
      return { ok: true, value: { action } };
    },
    async execute(): Promise<never> {
      throw new Error('settings.prefix must be confirmed before execution');
    }
  };
}

function ttsChannelSettingsTool(): AgentToolDefinition<{ action: 'set' | 'clear'; channelRef?: string }, never> {
  return channelSettingsTool('settings.tts_channel', 'Request a TTS watched-channel setting change.', 'tts');
}

function aiChannelSettingsTool(): AgentToolDefinition<{ action: 'set' | 'clear'; channelRef?: string }, never> {
  return channelSettingsTool('settings.ai_channel', 'Request an AI auto-chat channel setting change.', 'ai');
}

function channelSettingsTool(name: 'settings.tts_channel' | 'settings.ai_channel', description: string, fieldPrefix: string): AgentToolDefinition<{ action: 'set' | 'clear'; channelRef?: string }, never> {
  return {
    name,
    description: `${description} Requires action=set with channelRef, or action=clear. Do not pre-block for permissions; confirmation/admin path checks authority.`,
    inputSchema: "{ action: 'set'|'clear'; channelRef?: string }",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const action = input.action === 'set' || input.action === 'clear' ? input.action : undefined;
      const errors: string[] = [];
      if (!action) errors.push('action must be set or clear');
      const channelRef = typeof input.channelRef === 'string' ? input.channelRef.trim() : undefined;
      if (action === 'set' && !channelRef) errors.push('channelRef is required for set action');
      if (errors.length || !action) return { ok: false, errors };
      return { ok: true, value: { action, ...(channelRef ? { channelRef } : {}) } };
    },
    async execute(): Promise<never> {
      throw new Error(`${fieldPrefix} channel setting must be confirmed before execution`);
    }
  };
}

function webSearchSettingsTool(): AgentToolDefinition<{ mode: 'disabled' | 'explicit_only' | 'automatic' | 'search_first_factual' | 'default' }, never> {
  return {
    name: 'settings.web_search',
    description: 'Request a server web-search mode change.',
    inputSchema: "{ mode: 'disabled'|'explicit_only'|'automatic'|'search_first_factual'|'default' }",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      const modes = new Set(['disabled', 'explicit_only', 'automatic', 'search_first_factual', 'default']);
      if (typeof input.mode !== 'string' || !modes.has(input.mode)) return { ok: false, errors: ['mode must be disabled, explicit_only, automatic, search_first_factual, or default'] };
      return { ok: true, value: { mode: input.mode as 'disabled' | 'explicit_only' | 'automatic' | 'search_first_factual' | 'default' } };
    },
    async execute(): Promise<never> {
      throw new Error('settings.web_search must be confirmed before execution');
    }
  };
}

function memoryDeleteTool(): AgentToolDefinition<{ scope: 'guild' }, never> {
  return {
    name: 'memory.delete',
    description: 'Request deletion of server AI memory. Requires admin confirmation before execution.',
    inputSchema: "{ scope: 'guild' }",
    policy: 'confirmation_required',
    retryable: false,
    validate(input) {
      if (!isRecord(input)) return { ok: false, errors: ['input must be an object'] };
      if (input.scope !== 'guild') return { ok: false, errors: ['scope must be guild'] };
      return { ok: true, value: { scope: 'guild' } };
    },
    async execute(): Promise<never> {
      throw new Error('memory.delete must be confirmed before execution');
    }
  };
}

function blockedTool(name: string, description: string): AgentToolDefinition<Record<string, unknown>, never> {
  return nonAutoTool(name, description, 'blocked');
}

function nonAutoTool(name: string, description: string, policy: AgentToolPolicy): AgentToolDefinition<Record<string, unknown>, never> {
  return {
    name,
    description,
    inputSchema: '{ [key: string]: unknown }',
    policy,
    retryable: false,
    validate(input) {
      return { ok: true, value: isRecord(input) ? input : {} };
    },
    async execute() {
      throw new Error(`Tool ${name} is not auto-executable`);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): { value?: string; errors: string[] } {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { value: text, errors: [] } : { errors: [`${field} must be a non-empty string`] };
}

function optionalString(value: unknown, field: string): { value?: string; errors: string[] } {
  if (value === undefined) return { errors: [] };
  return typeof value === 'string' ? { value: value.trim() || undefined, errors: [] } : { errors: [`${field} must be a string`] };
}

function optionalInteger(value: unknown, field: string): { ok: true; value?: number; errors: [] } | { ok: false; errors: string[] } {
  if (value === undefined) return { ok: true, value: undefined, errors: [] };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, errors: [`${field} must be an integer`] };
  if (Math.abs(value) > 366 * 24 * 60 * 60) return { ok: false, errors: [`${field} is too large`] };
  return { ok: true, value, errors: [] };
}

function boundedInteger(value: unknown, field: string, min: number, max: number): { value?: number; errors: string[] } {
  if (typeof value !== 'number' || !Number.isInteger(value)) return { errors: [`${field} must be an integer`] };
  if (value < min || value > max) return { errors: [`${field} must be an integer from ${min} to ${max}`] };
  return { value, errors: [] };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatTimeInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(date);
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? '';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  return `${dayPeriod} ${hour}시 ${minute}분`.trim();
}
