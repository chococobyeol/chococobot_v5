import { describe, expect, it } from 'vitest';
import { AgentTurnContextStore } from '../src/services/agentTurnContextStore.js';

describe('AgentTurnContextStore', () => {
  it('stores one scoped context and expires it by TTL', () => {
    const store = new AgentTurnContextStore(1000);
    const key = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };

    store.set(key, {
      lastIntent: 'history',
      lastToolCalls: [{ tool: 'history.search', input: { query: '짬뽕' } }],
      slots: { topic: '짬뽕', scope: 'server', mode: 'summary' },
      observations: [{ status: 'ok' }]
    }, 10_000);

    expect(store.get(key, 10_500)).toEqual(expect.objectContaining({
      lastIntent: 'history',
      slots: { topic: '짬뽕', scope: 'server', mode: 'summary' }
    }));
    expect(store.get(key, 11_001)).toBeUndefined();
  });

  it('isolates contexts by guild, channel, and user', () => {
    const store = new AgentTurnContextStore();
    const key = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };
    store.set(key, { lastToolCalls: [], slots: { topic: 'x' }, observations: [] });

    expect(store.get({ ...key, userId: 'user-2' })).toBeUndefined();
    expect(store.get({ ...key, channelId: 'channel-2' })).toBeUndefined();
    expect(store.get(key)?.slots.topic).toBe('x');
  });
});
