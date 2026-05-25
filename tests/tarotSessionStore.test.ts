import { describe, expect, it } from 'vitest';
import { TarotSessionStore } from '../src/services/tarotSessionStore.js';

describe('TarotSessionStore', () => {
  const key = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };

  it('stores requester/channel scoped tarot sessions with TTL', () => {
    const store = new TarotSessionStore(10_000);
    const session = store.start(key, {
      topic: '연애운',
      spreadCount: 3,
      spreadName: '현재 흐름',
      requesterDisplayName: '테스터',
      seed: 'seed-1'
    }, 1_000);

    expect(session.expiresAt).toBe(11_000);
    expect(store.get(key, 1_000)).toMatchObject({ topic: '연애운', spreadCount: 3, requesterDisplayName: '테스터' });
    expect(store.get(key, 12_000)).toBeUndefined();
  });

  it('finds active channel sessions for wrong-requester feedback without consuming them', () => {
    const store = new TarotSessionStore(10_000);
    store.start(key, { topic: '취업운', spreadCount: 2, requesterDisplayName: '테스터', seed: 'seed-2' }, 1_000);

    const active = store.getActiveInChannel('guild-1', 'channel-1', 1_500);
    expect(active).toMatchObject({ key, session: expect.objectContaining({ topic: '취업운' }) });
    expect(store.get(key, 1_500)).toBeDefined();
  });

  it('consumes only the requester session after a successful reveal', () => {
    const store = new TarotSessionStore(10_000);
    store.start(key, { topic: '오늘 운세', spreadCount: 1, requesterDisplayName: '테스터', seed: 'seed-3' }, 1_000);

    const consumed = store.consume(key, 2_000);

    expect(consumed).toMatchObject({ topic: '오늘 운세', spreadCount: 1 });
    expect(store.get(key, 2_000)).toBeUndefined();
  });
});
