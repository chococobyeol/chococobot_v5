import { randomUUID } from 'node:crypto';

export type ConfirmationIntent = 'cleanup' | 'prefix-change' | 'memory-reset' | 'watch-channel' | 'ai-channel' | 'web-search';

export type ConfirmationScope = {
  guildId: string;
  channelId: string;
  userId: string;
  intent: ConfirmationIntent;
  targetChannelId?: string | null;
  normalizedArgs: string;
  commandQuery: string;
};

export type PendingConfirmation = ConfirmationScope & {
  token: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
};

export class ConfirmationManager {
  private readonly confirmations = new Map<string, PendingConfirmation>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  create(scope: ConfirmationScope, preview: string): PendingConfirmation {
    this.pruneExpired();
    const createdAt = this.now();
    const confirmation: PendingConfirmation = {
      ...scope,
      token: randomUUID(),
      preview,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this.confirmations.set(confirmation.token, confirmation);
    return confirmation;
  }

  get(token: string, scope?: ConfirmationScope): PendingConfirmation | undefined {
    this.pruneExpired();
    const confirmation = this.confirmations.get(token);
    if (!confirmation) return undefined;
    if (scope && !this.matchesScope(confirmation, scope)) return undefined;
    return confirmation;
  }

  consume(token: string, scope?: ConfirmationScope): PendingConfirmation | undefined {
    const confirmation = this.get(token, scope);
    if (!confirmation) return undefined;
    this.confirmations.delete(token);
    return confirmation;
  }

  latestForActor(scope: Pick<ConfirmationScope, 'guildId' | 'channelId' | 'userId'>): PendingConfirmation | undefined {
    this.pruneExpired();
    return Array.from(this.confirmations.values())
      .reverse()
      .find((confirmation) => (
        confirmation.guildId === scope.guildId &&
        confirmation.channelId === scope.channelId &&
        confirmation.userId === scope.userId
      ));
  }

  consumeLatestForActor(scope: Pick<ConfirmationScope, 'guildId' | 'channelId' | 'userId'>): PendingConfirmation | undefined {
    const latest = this.latestForActor(scope);
    if (!latest) return undefined;
    this.confirmations.delete(latest.token);
    return latest;
  }

  cancel(token: string, scope?: ConfirmationScope): boolean {
    const confirmation = this.get(token, scope);
    if (!confirmation) return false;
    this.confirmations.delete(token);
    return true;
  }

  pruneExpired(now = this.now()): number {
    let removed = 0;
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAt <= now) {
        this.confirmations.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  private matchesScope(left: ConfirmationScope, right: ConfirmationScope): boolean {
    return (
      left.guildId === right.guildId &&
      left.channelId === right.channelId &&
      left.userId === right.userId &&
      left.intent === right.intent &&
      (left.targetChannelId ?? null) === (right.targetChannelId ?? null) &&
      left.normalizedArgs === right.normalizedArgs &&
      left.commandQuery === right.commandQuery
    );
  }
}
