import { describe, expect, it } from 'vitest';
import {
  TAROT_CARD_COUNT,
  TAROT_DECK,
  createTarotDeckOrder,
  drawTarotCardsFromNumbers,
  formatTarotEnergyBars,
  validateTarotSelectionNumbers
} from '../src/services/tarotDeck.js';

describe('tarot deck helpers', () => {
  it('defines a complete 78-card deck with safe repo-owned asset paths', () => {
    expect(TAROT_CARD_COUNT).toBe(78);
    expect(TAROT_DECK).toHaveLength(78);
    expect(new Set(TAROT_DECK.map((card) => card.id))).toHaveLength(78);
    expect(new Set(TAROT_DECK.map((card) => card.assetPath))).toHaveLength(78);
    expect(TAROT_DECK.every((card) => card.assetPath.startsWith('assets/tarot/'))).toBe(true);
    expect(TAROT_DECK.every((card) => card.assetPath.endsWith('.png'))).toBe(true);
  });

  it('creates a deterministic shuffled deck order from a session seed', () => {
    const first = createTarotDeckOrder('guild:channel:user:topic:1000');
    const second = createTarotDeckOrder('guild:channel:user:topic:1000');
    const different = createTarotDeckOrder('guild:channel:user:topic:2000');

    expect(first).toHaveLength(78);
    expect(new Set(first)).toHaveLength(78);
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  it('maps user-selected 1-78 positions to cards without exposing arbitrary paths', () => {
    const deckOrder = createTarotDeckOrder('stable-session');
    const draw = drawTarotCardsFromNumbers([1, 7, 78], deckOrder);

    expect(draw).toHaveLength(3);
    expect(draw.map((item) => item.selectionNumber)).toEqual([1, 7, 78]);
    expect(draw.every((item) => item.card.assetPath.startsWith('assets/tarot/'))).toBe(true);
    expect(draw.every((item) => item.attachmentName.endsWith('.png'))).toBe(true);
  });

  it('validates duplicate, out-of-range, and wrong-count selections with Korean feedback', () => {
    expect(validateTarotSelectionNumbers([1, 2, 3], 3)).toEqual({ ok: true, numbers: [1, 2, 3] });
    expect(validateTarotSelectionNumbers([1, 1, 2], 3)).toMatchObject({ ok: false, code: 'duplicate_numbers', field: 'numbers', message: expect.stringContaining('중복') });
    expect(validateTarotSelectionNumbers([0, 2, 3], 3)).toMatchObject({ ok: false, code: 'number_out_of_range', field: 'numbers', message: expect.stringContaining('1~78') });
    expect(validateTarotSelectionNumbers([1, 2], 3)).toMatchObject({ ok: false, code: 'wrong_count', field: 'numbers', message: expect.stringContaining('개수가 요청과 다릅니다'), hint: expect.stringContaining('Expected 3') });
    expect(validateTarotSelectionNumbers([1, 1], 1)).toMatchObject({ ok: false, code: 'wrong_count', field: 'numbers', message: expect.stringContaining('개수가 요청과 다릅니다'), hint: expect.stringContaining('received 2') });
  });

  it('formats graph-like summary bars from selected cards', () => {
    const draw = drawTarotCardsFromNumbers([1, 2, 3], createTarotDeckOrder('bars'));
    const bars = formatTarotEnergyBars(draw);

    expect(bars).toContain('흐름');
    expect(bars).toContain('▰');
    expect(bars.length).toBeLessThan(500);
  });
});
