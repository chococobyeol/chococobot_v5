import { describe, expect, it } from 'vitest';
import { ConfirmationManager } from '../src/services/confirmationManager.js';

describe('ConfirmationManager', () => {
  it('isolates confirmations by scope and expires them by ttl', () => {
    let now = 1_000;
    const manager = new ConfirmationManager(500, () => now);
    const scope = {
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      intent: 'cleanup' as const,
      targetChannelId: undefined,
      normalizedArgs: '10',
      commandQuery: '청소 10'
    };

    const pending = manager.create(scope, 'preview');
    expect(manager.get(pending.token, scope)).toEqual(expect.objectContaining({ preview: 'preview' }));
    expect(
      manager.get(pending.token, {
        ...scope,
        normalizedArgs: '20'
      })
    ).toBeUndefined();

    now += 501;
    expect(manager.get(pending.token, scope)).toBeUndefined();
  });

  it('consumes the latest confirmation for the same actor', () => {
    const manager = new ConfirmationManager(5_000, () => 1_000);
    const first = manager.create({
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      intent: 'cleanup',
      normalizedArgs: '1',
      commandQuery: '대청소 1'
    }, 'first');
    const second = manager.create({
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      intent: 'cleanup',
      normalizedArgs: '2',
      commandQuery: '대청소 2'
    }, 'second');

    expect(manager.consumeLatestForActor({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' })).toEqual(second);
    expect(manager.get(second.token)).toBeUndefined();
    expect(manager.get(first.token)).toEqual(first);
  });

  it('consumes and cancels only matching scope entries', () => {
    const manager = new ConfirmationManager(5_000, () => 1_000);
    const scope = {
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'user-1',
      intent: 'memory-reset' as const,
      targetChannelId: 'channel-2',
      normalizedArgs: 'reset',
      commandQuery: '기억삭제'
    };

    const pending = manager.create(scope, 'preview');
    expect(manager.cancel(pending.token, scope)).toBe(true);
    expect(manager.get(pending.token, scope)).toBeUndefined();

    const second = manager.create(scope, 'preview');
    expect(manager.consume(second.token, scope)).toEqual(expect.objectContaining({ token: second.token }));
    expect(manager.get(second.token, scope)).toBeUndefined();
  });
});
