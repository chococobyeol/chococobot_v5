export type AgentTurnKey = {
  guildId: string;
  channelId: string;
  userId: string;
};

export type AgentCleanupPendingAction = {
  kind: 'cleanup';
  originalPrompt: string;
  target?: 'self' | 'channel' | 'other' | 'ambiguous';
  count?: number;
  /**
   * AI-owned internal safety quote proving requester-owned cleanup intent.
   * Never expose this as a user-facing missing slot; ask only for target/count.
   */
  cleanupEvidence?: string;
  /** Only user-answerable cleanup slots are allowed here. */
  missing: Array<'target' | 'count'>;
};

export type AgentHistoryPendingAction = {
  kind: 'history';
  originalPrompt: string;
  scope?: 'server' | 'channel';
  channelRef?: string;
  query: string;
  mode: 'qa' | 'summary';
  missing: Array<'scope' | 'channel'>;
};

export type AgentTarotPendingAction = {
  kind: 'tarot';
  originalPrompt: string;
  topic: string;
  spreadCount: number;
  spreadName?: string;
  missing: Array<'numbers'>;
};

export type AgentPendingAction = AgentCleanupPendingAction | AgentHistoryPendingAction | AgentTarotPendingAction;

export type AgentTurnStoredContext = {
  lastIntent?: string;
  lastUserPrompt?: string;
  lastAgentMessage?: string;
  lastToolCalls: Array<{ tool: string; input: unknown }>;
  slots: {
    topic?: string;
    scope?: 'server' | 'channel';
    channelRef?: string;
    timeZones?: string[];
    mode?: 'qa' | 'summary';
  };
  observations: unknown[];
  pendingAction?: AgentPendingAction;
  updatedAt: number;
};

export class AgentTurnContextStore {
  private readonly entries = new Map<string, AgentTurnStoredContext>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  get(key: AgentTurnKey, now = Date.now()): AgentTurnStoredContext | undefined {
    const stored = this.entries.get(this.keyFor(key));
    if (!stored) return undefined;
    if (now - stored.updatedAt > this.ttlMs) {
      this.entries.delete(this.keyFor(key));
      return undefined;
    }
    return structuredCloneSafe(stored);
  }

  set(key: AgentTurnKey, context: Omit<AgentTurnStoredContext, 'updatedAt'>, now = Date.now()): void {
    this.entries.set(this.keyFor(key), structuredCloneSafe({ ...context, updatedAt: now }));
  }

  clear(key: AgentTurnKey): void {
    this.entries.delete(this.keyFor(key));
  }

  clearAll(): void {
    this.entries.clear();
  }

  private keyFor(key: AgentTurnKey): string {
    return `${key.guildId}:${key.channelId}:${key.userId}`;
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
