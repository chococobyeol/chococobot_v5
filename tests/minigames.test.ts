import { describe, expect, it } from 'vitest';
import { drawChoices } from '../src/commands/minigames.js';

describe('drawChoices', () => {
  it('draws requested number of unique choices', () => {
    const result = drawChoices('a, b, c', 2);
    expect(result).toHaveLength(2);
    expect(new Set(result).size).toBe(2);
  });

  it('rejects drawing more than available choices', () => {
    expect(() => drawChoices('a,b', 3)).toThrow(/많아요/);
  });
});
