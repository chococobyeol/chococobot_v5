import { createTarotDeckOrder } from './tarotDeck.js';

export type TarotSessionKey = {
  guildId: string;
  channelId: string;
  userId: string;
};

export type TarotSession = {
  topic: string;
  spreadCount: number;
  spreadName?: string;
  requesterDisplayName?: string;
  deckOrder: number[];
  createdAt: number;
  expiresAt: number;
};

export type TarotSessionStartInput = {
  topic: string;
  spreadCount: number;
  spreadName?: string;
  requesterDisplayName?: string;
  seed?: string;
};

export class TarotSessionStore {
  private readonly sessions = new Map<string, { key: TarotSessionKey; session: TarotSession }>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  start(key: TarotSessionKey, input: TarotSessionStartInput, now = Date.now()): TarotSession {
    const seed = input.seed ?? `${key.guildId}:${key.channelId}:${key.userId}:${input.topic}:${now}`;
    const session: TarotSession = {
      topic: input.topic.trim(),
      spreadCount: input.spreadCount,
      ...(input.spreadName?.trim() ? { spreadName: input.spreadName.trim() } : {}),
      ...(input.requesterDisplayName?.trim() ? { requesterDisplayName: input.requesterDisplayName.trim() } : {}),
      deckOrder: createTarotDeckOrder(seed),
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.sessions.set(this.keyFor(key), { key: { ...key }, session: cloneSession(session) });
    return cloneSession(session);
  }

  get(key: TarotSessionKey, now = Date.now()): TarotSession | undefined {
    const entry = this.sessions.get(this.keyFor(key));
    if (!entry) return undefined;
    if (entry.session.expiresAt <= now) {
      this.sessions.delete(this.keyFor(key));
      return undefined;
    }
    return cloneSession(entry.session);
  }

  getActiveInChannel(guildId: string, channelId: string, now = Date.now()): { key: TarotSessionKey; session: TarotSession } | undefined {
    for (const [storedKey, entry] of this.sessions.entries()) {
      if (entry.session.expiresAt <= now) {
        this.sessions.delete(storedKey);
        continue;
      }
      if (entry.key.guildId === guildId && entry.key.channelId === channelId) {
        return { key: { ...entry.key }, session: cloneSession(entry.session) };
      }
    }
    return undefined;
  }

  consume(key: TarotSessionKey, now = Date.now()): TarotSession | undefined {
    const session = this.get(key, now);
    if (!session) return undefined;
    this.sessions.delete(this.keyFor(key));
    return session;
  }

  clear(key: TarotSessionKey): void {
    this.sessions.delete(this.keyFor(key));
  }

  clearExpired(now = Date.now()): void {
    for (const [storedKey, entry] of this.sessions.entries()) {
      if (entry.session.expiresAt <= now) this.sessions.delete(storedKey);
    }
  }

  private keyFor(key: TarotSessionKey): string {
    return `${key.guildId}:${key.channelId}:${key.userId}`;
  }
}

function cloneSession(session: TarotSession): TarotSession {
  return { ...session, deckOrder: [...session.deckOrder] };
}
