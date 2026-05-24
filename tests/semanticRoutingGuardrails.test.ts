import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guardedSources = [
  'src/bot.ts',
  'src/services/agentRuntime.ts',
  'src/services/aiCommandPlanner.ts',
  'src/services/nlCommandRouter.ts',
  'src/services/channelHistoryService.ts'
];

const forbiddenSemanticParsers = [
  'isAffirmativeConfirmationReply',
  'hasReadOnlyIntent',
  'cleanVoiceText',
  'isSummaryOnlyHistoryQuery',
  'isFuzzyTopicLookupQuery',
  'mentionsRequesterCleanup',
  'mentionsChannelWideCleanup',
  'mentionsOtherUserCleanup',
  'hasSelfReference',
  'routeChannelHistory',
  'hasBroadScope',
  'containsAny',
  'isExplicitWebSearchPrompt',
  'matchesPlannerPattern',
  'promptMatchesAgentHint',
  'selectPlannerPromptSections',
  'selectAgentToolDetails'
];

describe('AI routing guardrails', () => {
  it('keeps natural-language semantic intent out of deterministic parser helpers', () => {
    const source = guardedSources.map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const forbidden of forbiddenSemanticParsers) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('documents the AI-vs-code routing boundary', () => {
    const doc = readFileSync('docs/ai-routing-guardrails.md', 'utf8');

    expect(doc).toContain('AI to judge user intent');
    expect(doc).toContain('must not re-interpret natural-language meaning');
    expect(doc).toContain('confirm_pending');
    expect(doc).toContain('pendingAction');
    expect(doc).toContain('web_search_unavailable');
  });
});
