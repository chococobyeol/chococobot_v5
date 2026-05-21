import { Collection, PermissionFlagsBits, type Message, type Snowflake } from 'discord.js';

export const DISCORD_BULK_DELETE_LIMIT = 100;
export const DISCORD_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_OWN_CLEANUP_TARGET = 500;
export const DEFAULT_PURGE_TARGET = 1000;
export const DEFAULT_CLEANUP_MAX_TARGET = 1000;
export const DEFAULT_CLEANUP_SCAN_MULTIPLIER = 10;

export type CleanupMode = 'own' | 'purge';

export type CleanupFetchableChannel = {
  messages: {
    fetch(options: { limit: number; before?: Snowflake }): Promise<Collection<Snowflake, Message> | Message[]>;
  };
  bulkDelete(messages: readonly Message[], filterOld?: boolean): Promise<{ size: number } | readonly unknown[]>;
};

export type CleanupOptions = {
  target?: number | null;
  defaultTarget: number;
  maxTarget?: number;
  now?: number | Date;
  maxScanBatches?: number;
  excludedMessageIds?: readonly Snowflake[];
};

export type CleanupResult = {
  requested: number;
  scanned: number;
  matched: number;
  deleted: number;
  skippedOld: number;
  batches: number[];
  exhausted: boolean;
};

export function mineMessageFilter(userId: string): (message: Pick<Message, 'author'>) => boolean {
  return (message) => message.author.id === userId;
}

export function normalizeCleanupTarget(options: CleanupOptions): number {
  const maxTarget = Math.max(1, Math.floor(options.maxTarget ?? DEFAULT_CLEANUP_MAX_TARGET));
  const defaultTarget = Math.min(Math.max(1, Math.floor(options.defaultTarget)), maxTarget);
  const requested = options.target ?? defaultTarget;
  if (!Number.isFinite(requested)) return defaultTarget;
  return Math.min(Math.max(1, Math.floor(requested)), maxTarget);
}

export function isBulkDeletable(message: Pick<Message, 'createdTimestamp'>, now: number | Date = Date.now()): boolean {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return nowMs - message.createdTimestamp < DISCORD_BULK_DELETE_MAX_AGE_MS;
}

export function hasManageMessages(permissions: { has(permission: bigint): boolean } | null | undefined): boolean {
  return Boolean(permissions?.has(PermissionFlagsBits.ManageMessages));
}

function collectionToArray(messages: Collection<Snowflake, Message> | Message[]): Message[] {
  return Array.isArray(messages) ? messages : Array.from(messages.values());
}

function deletedSize(messages: { size: number } | readonly unknown[]): number {
  return 'size' in messages ? messages.size : messages.length;
}

async function deleteBatch(channel: CleanupFetchableChannel, batch: Message[]): Promise<number> {
  if (batch.length === 0) return 0;
  if (batch.length === 1 && typeof batch[0]?.delete === 'function') {
    await batch[0].delete();
    return 1;
  }
  return deletedSize(await channel.bulkDelete(batch, false));
}

async function collectCandidates(
  channel: CleanupFetchableChannel,
  requested: number,
  filter: (message: Message) => boolean,
  maxScanBatches: number,
  excludedMessageIds: readonly Snowflake[] = []
): Promise<{ candidates: Message[]; scanned: number; exhausted: boolean }> {
  const candidates: Message[] = [];
  const excluded = new Set(excludedMessageIds);
  let scanned = 0;
  let before: Snowflake | undefined;
  let exhausted = false;

  for (let page = 0; page < maxScanBatches && candidates.length < requested; page += 1) {
    const fetched = collectionToArray(await channel.messages.fetch({ limit: DISCORD_BULK_DELETE_LIMIT, before }));
    if (fetched.length === 0) {
      exhausted = true;
      break;
    }

    scanned += fetched.length;
    candidates.push(...fetched.filter((message) => !excluded.has(message.id) && filter(message)));
    before = fetched[fetched.length - 1]?.id;

    if (fetched.length < DISCORD_BULK_DELETE_LIMIT || before === undefined) {
      exhausted = true;
      break;
    }
  }

  return { candidates: candidates.slice(0, requested), scanned, exhausted };
}

export async function cleanupMessages(
  channel: CleanupFetchableChannel,
  mode: CleanupMode,
  options: CleanupOptions & { userId?: string }
): Promise<CleanupResult> {
  if (mode === 'own' && !options.userId) throw new Error('userId is required for own-message cleanup.');

  const requested = normalizeCleanupTarget(options);
  const maxScanBatches = Math.max(
    Math.ceil(requested / DISCORD_BULK_DELETE_LIMIT),
    options.maxScanBatches ?? Math.ceil(requested / DISCORD_BULK_DELETE_LIMIT) * DEFAULT_CLEANUP_SCAN_MULTIPLIER
  );
  const filter = mode === 'own' ? mineMessageFilter(options.userId!) : () => true;
  const { candidates, scanned, exhausted } = await collectCandidates(
    channel,
    requested,
    filter,
    maxScanBatches,
    options.excludedMessageIds ?? []
  );
  const deletable = candidates.filter((message) => isBulkDeletable(message, options.now));
  const skippedOld = candidates.length - deletable.length;
  const batches: number[] = [];
  let deleted = 0;

  for (let index = 0; index < deletable.length; index += DISCORD_BULK_DELETE_LIMIT) {
    const batch = deletable.slice(index, index + DISCORD_BULK_DELETE_LIMIT);
    batches.push(batch.length);
    deleted += await deleteBatch(channel, batch);
  }

  return {
    requested,
    scanned,
    matched: candidates.length,
    deleted,
    skippedOld,
    batches,
    exhausted
  };
}

export function cleanupUserMessages(
  channel: CleanupFetchableChannel,
  userId: string,
  options: Partial<CleanupOptions> = {}
): Promise<CleanupResult> {
  return cleanupMessages(channel, 'own', {
    defaultTarget: DEFAULT_OWN_CLEANUP_TARGET,
    ...options,
    userId
  });
}

export function cleanupChannelMessages(
  channel: CleanupFetchableChannel,
  options: Partial<CleanupOptions> = {}
): Promise<CleanupResult> {
  return cleanupMessages(channel, 'purge', {
    defaultTarget: DEFAULT_PURGE_TARGET,
    ...options
  });
}

export function formatCleanupResult(label: string, result: CleanupResult): string {
  const partial = result.deleted < result.requested ? ` (요청 ${result.requested}개 중 처리)` : '';
  const skipped = result.skippedOld > 0 ? `, 2주 초과 ${result.skippedOld}개 건너뜀` : '';
  return `${label} ${result.deleted}개를 삭제했어요...${partial}${skipped}`;
}
