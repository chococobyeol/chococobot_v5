import { Collection } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { mineMessageFilter } from '../src/commands/cleanup.js';
import {
  DEFAULT_OWN_CLEANUP_TARGET,
  DEFAULT_PURGE_TARGET,
  DISCORD_BULK_DELETE_LIMIT,
  cleanupChannelMessages,
  cleanupUserMessages,
  hasManageMessages,
  isBulkDeletable,
  normalizeCleanupTarget
} from '../src/services/cleanupService.js';

type FakeMessage = {
  id: string;
  author: { id: string };
  createdTimestamp: number;
  delete: ReturnType<typeof vi.fn>;
};

function message(id: number, authorId = 'u1', ageMs = 0): FakeMessage {
  return {
    id: String(id),
    author: { id: authorId },
    createdTimestamp: Date.now() - ageMs,
    delete: vi.fn(async () => undefined)
  };
}

function fakeChannel(pages: FakeMessage[][]) {
  const fetch = vi.fn(async () => {
    const page = pages.shift() ?? [];
    return new Collection(page.map((item) => [item.id, item]));
  });
  const bulkDelete = vi.fn(async (items: FakeMessage[]) => new Collection(items.map((item) => [item.id, item])));
  return { messages: { fetch }, bulkDelete };
}

describe('mineMessageFilter', () => {
  it('matches only messages from the requested user', () => {
    const filter = mineMessageFilter('u1');
    expect(filter({ author: { id: 'u1' } } as any)).toBe(true);
    expect(filter({ author: { id: 'u2' } } as any)).toBe(false);
  });
});

describe('cleanupService', () => {
  it('uses 500 and 1000 as default cleanup targets', () => {
    expect(normalizeCleanupTarget({ defaultTarget: DEFAULT_OWN_CLEANUP_TARGET })).toBe(500);
    expect(normalizeCleanupTarget({ defaultTarget: DEFAULT_PURGE_TARGET })).toBe(1000);
  });

  it('clamps requested cleanup amounts to the configured max', () => {
    expect(normalizeCleanupTarget({ target: 2000, defaultTarget: 500, maxTarget: 750 })).toBe(750);
    expect(normalizeCleanupTarget({ target: 0, defaultTarget: 500, maxTarget: 750 })).toBe(1);
  });

  it('scans multiple pages to delete up to 500 invoking-user messages', async () => {
    const pages = Array.from({ length: 5 }, (_, page) =>
      Array.from({ length: DISCORD_BULK_DELETE_LIMIT }, (_, index) => message(page * DISCORD_BULK_DELETE_LIMIT + index))
    );
    const channel = fakeChannel(pages);

    const result = await cleanupUserMessages(channel as any, 'u1');

    expect(result.requested).toBe(500);
    expect(result.scanned).toBe(500);
    expect(result.matched).toBe(500);
    expect(result.deleted).toBe(500);
    expect(result.batches).toEqual([100, 100, 100, 100, 100]);
    expect(channel.messages.fetch).toHaveBeenCalledTimes(5);
    expect(channel.bulkDelete).toHaveBeenCalledTimes(5);
    for (const [items] of channel.bulkDelete.mock.calls) expect(items).toHaveLength(100);
  });

  it('filters own cleanup to the invoking user before deleting', async () => {
    const channel = fakeChannel([[message(1, 'u2'), message(2, 'u1'), message(3, 'u1')]]);

    const result = await cleanupUserMessages(channel as any, 'u1', { target: 2 });

    expect(result.deleted).toBe(2);
    expect(channel.bulkDelete.mock.calls[0][0].map((item: FakeMessage) => item.author.id)).toEqual(['u1', 'u1']);
  });

  it('can exclude the invoking command message from cleanup counts', async () => {
    const channel = fakeChannel([[message(1, 'u1'), message(2, 'u1'), message(3, 'u1'), message(4, 'u1')]]);

    const result = await cleanupUserMessages(channel as any, 'u1', { target: 3, excludedMessageIds: ['2'] });

    expect(result.deleted).toBe(3);
    expect(channel.bulkDelete.mock.calls[0][0].map((item: FakeMessage) => item.id)).toEqual(['1', '3', '4']);
  });

  it('purges 1000 channel messages in API-safe batches of 100 or fewer', async () => {
    const pages = Array.from({ length: 10 }, (_, page) =>
      Array.from({ length: DISCORD_BULK_DELETE_LIMIT }, (_, index) => message(page * DISCORD_BULK_DELETE_LIMIT + index))
    );
    const channel = fakeChannel(pages);

    const result = await cleanupChannelMessages(channel as any);

    expect(result.requested).toBe(1000);
    expect(result.deleted).toBe(1000);
    expect(result.batches).toHaveLength(10);
    expect(result.batches.every((size) => size <= DISCORD_BULK_DELETE_LIMIT)).toBe(true);
    expect(channel.bulkDelete).toHaveBeenCalledTimes(10);
  });

  it('skips and reports messages older than two weeks', async () => {
    const oldAge = 15 * 24 * 60 * 60 * 1000;
    const channel = fakeChannel([[message(1, 'u1', oldAge), message(2), message(3, 'u1', oldAge)]]);

    const result = await cleanupUserMessages(channel as any, 'u1', { target: 3 });

    expect(isBulkDeletable({ createdTimestamp: Date.now() - oldAge })).toBe(false);
    expect(result.skippedOld).toBe(2);
    expect(result.deleted).toBe(1);
    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });

  it('exposes a ManageMessages permission gate for purge commands', () => {
    expect(hasManageMessages({ has: (permission) => permission === 1n << 13n })).toBe(true);
    expect(hasManageMessages({ has: () => false })).toBe(false);
    expect(hasManageMessages(null)).toBe(false);
  });
});
