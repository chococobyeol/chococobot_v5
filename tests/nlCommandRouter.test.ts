import { describe, expect, it } from 'vitest';
import { routeNaturalLanguageCommand } from '../src/services/nlCommandRouter.js';

describe('routeNaturalLanguageCommand', () => {
  it('clarifies a bare trigger and preserves fallback-AI for unsupported payloads', () => {
    expect(routeNaturalLanguageCommand('!?', '!')).toEqual(
      expect.objectContaining({
        kind: 'clarify'
      })
    );
    expect(routeNaturalLanguageCommand('!? 알려줘', '!')).toBeNull();
  });

  it('routes help, join, speak, and confirmation-gated intents', () => {
    expect(routeNaturalLanguageCommand('!? help', '!')).toEqual(
      expect.objectContaining({
        kind: 'command',
        query: 'help'
      })
    );
    expect(routeNaturalLanguageCommand('!? 들어와', '!')).toEqual(
      expect.objectContaining({
        kind: 'command',
        query: '들어와'
      })
    );
    expect(routeNaturalLanguageCommand('!? say 안녕', '!')).toEqual(
      expect.objectContaining({
        kind: 'command',
        query: '말 안녕'
      })
    );
    expect(routeNaturalLanguageCommand('!? 대청소 10', '!')).toEqual(
      expect.objectContaining({
        kind: 'confirmation',
        intent: 'cleanup'
      })
    );
  });

  it('routes channel-history queries for specified target channels', () => {
    expect(routeNaturalLanguageCommand('!? #general 요약해줘', '!')).toEqual(
      expect.objectContaining({
        kind: 'channel-history',
        mode: 'summary',
        targetChannelReference: '#general'
      })
    );
    expect(routeNaturalLanguageCommand('?? #general 질문이 뭐야?', '?')).toEqual(
      expect.objectContaining({
        kind: 'channel-history',
        mode: 'qa',
        targetChannelReference: '#general'
      })
    );
  });
});
