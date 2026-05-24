import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = () => readFileSync('docs/tool-authoring-guide.md', 'utf8');

describe('tool authoring guide', () => {
  it('covers the Stage 7 contract topics for future tools', () => {
    const doc = guide();

    for (const heading of [
      'When to create a tool',
      'Tool naming and purpose',
      'Policy selection',
      'Input schema and required fields',
      'Validation error code/field/hint pattern',
      'Confirmation and admin pattern',
      'Observation output rules',
      'Runtime loop expectations',
      'Required tests for new tools',
      'Anti-patterns'
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('guards against prompt-only or hidden legacy routing guidance', () => {
    const doc = guide();

    for (const required of [
      'read_only_auto',
      'safe_action_auto',
      'confirmation_required',
      "status: 'error'",
      'code',
      'field',
      'hint',
      'confirm_pending',
      'Prompt-only tool behavior',
      'Prose keyword classifiers',
      'Unbounded retries',
      'Hidden fallback command conversion'
    ]) {
      expect(doc).toContain(required);
    }
  });
});
