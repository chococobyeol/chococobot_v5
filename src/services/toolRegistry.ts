export type AgentToolPolicy = 'read_only_auto' | 'legacy_single_action' | 'confirmation_required' | 'blocked';

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

export type AgentToolExecutionContext = {
  nowMs: number;
  message?: unknown;
  botContext?: unknown;
};

export type AgentToolObservation = {
  callId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked';
  policy: AgentToolPolicy;
  output?: unknown;
  error?: string;
};

export type HistorySearchInput = {
  scope: 'server' | 'channel';
  channelRef?: string;
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

export type ToolRegistryHandlers = {
  historySearch?: (input: HistorySearchInput, context: AgentToolExecutionContext) => Promise<HistorySearchOutput>;
  historySummarize?: (input: HistorySummarizeInput, context: AgentToolExecutionContext) => Promise<{ message: string }>;
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
      return { callId: '', toolName: name, status: 'error', policy: 'blocked', error: `Unknown tool: ${name}` };
    }
    const validated = tool.validate(input);
    if (!validated.ok) {
      return { callId: '', toolName: name, status: 'error', policy: tool.policy, error: validated.errors.join('; ') };
    }
    if (tool.policy !== 'read_only_auto') {
      return { callId: '', toolName: name, status: 'blocked', policy: tool.policy, error: `Tool policy ${tool.policy} is not auto-executable` };
    }
    try {
      return { callId: '', toolName: name, status: 'ok', policy: tool.policy, output: await tool.execute(validated.value, context) };
    } catch (error) {
      return { callId: '', toolName: name, status: 'error', policy: tool.policy, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function createDefaultToolRegistry(handlers: ToolRegistryHandlers = {}): ToolRegistry {
  return new ToolRegistry([
    timeViewerTool(),
    timeInZoneTool(),
    historySearchTool(handlers),
    historySummarizeTool(handlers),
    blockedTool('voice.speak', 'Speak text in a Discord voice channel.'),
    confirmationTool('command.cleanup', 'Delete recent user messages.'),
    confirmationTool('command.mass_cleanup', 'Delete recent channel messages.'),
    confirmationTool('settings.prefix', 'Change server command prefix.'),
    confirmationTool('settings.tts_channel', 'Change TTS watched channel settings.'),
    confirmationTool('memory.delete', 'Delete AI memory.'),
    blockedTool('admin.log_management', 'Manage bot logging channels.')
  ]);
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
    inputSchema: "{ scope: 'server'|'channel'; channelRef?: string; query: string; mode: 'qa'|'summary'; limit?: number }",
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
      const limit = input.limit === undefined ? undefined : Number(input.limit);
      if (!scope) errors.push('scope must be server or channel');
      if (!mode) errors.push('mode must be qa or summary');
      if (!query) errors.push('query must be a non-empty string');
      if (scope === 'channel' && !channelRef) errors.push('channelRef is required for channel scope');
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) errors.push('limit must be an integer from 1 to 500');
      if (errors.length || !scope || !mode) return { ok: false, errors };
      return { ok: true, value: { scope, mode, query, channelRef, limit } };
    },
    async execute(input, context) {
      if (!handlers.historySearch) throw new Error('history.search is unavailable in this runtime');
      return handlers.historySearch(input, context);
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

function blockedTool(name: string, description: string): AgentToolDefinition<Record<string, unknown>, never> {
  return nonAutoTool(name, description, 'blocked');
}

function confirmationTool(name: string, description: string): AgentToolDefinition<Record<string, unknown>, never> {
  return nonAutoTool(name, description, 'confirmation_required');
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
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) return { ok: false, errors: [`${field} must be an integer`] };
  if (Math.abs(numberValue) > 366 * 24 * 60 * 60) return { ok: false, errors: [`${field} is too large`] };
  return { ok: true, value: numberValue, errors: [] };
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
