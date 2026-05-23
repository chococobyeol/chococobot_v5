import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/services/agentRuntime.js';
import { AgentTurnContextStore } from '../src/services/agentTurnContextStore.js';
import { createDefaultToolRegistry } from '../src/services/toolRegistry.js';

function makeMessage() {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdTimestamp: Date.parse('2026-05-22T18:15:00.000Z'),
    author: { id: 'user-1', username: 'tester', bot: false },
    member: { displayName: '테스터' }
  } as any;
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    prefix: '!',
    commands: [{ name: '말', aliases: ['say'], description: '음성 채널에서 읽기' }],
    availableChannels: [{ id: 'channel-1', name: 'general', mention: '<#channel-1>' }],
    botVoiceConnected: false,
    executionContext: { nowMs: Date.parse('2026-05-22T18:15:00.000Z') },
    ...overrides
  } as any;
}

describe('AgentRuntime', () => {
  it('runs multiple read-only time tools before returning a Korean final answer', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [
            { id: 'east', tool: 'time.in_zone', input: { timeZone: 'America/New_York', label: '동부' } },
            { id: 'central', tool: 'time.in_zone', input: { timeZone: 'America/Chicago', label: '중부' } },
            { id: 'mountain', tool: 'time.in_zone', input: { timeZone: 'America/Denver', label: '산악' } },
            { id: 'pacific', tool: 'time.in_zone', input: { timeZone: 'America/Los_Angeles', label: '태평양' } }
          ]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '동부, 중부, 산악, 태평양 시간을 확인했어요...' }))
    };
    const diagnostics: unknown[] = [];
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '미국 시간대별로 지금 몇시야', makeOptions({ onDiagnostic: (event: unknown) => diagnostics.push(event) }));

    expect(outcome).toEqual({ kind: 'final', message: '동부, 중부, 산악, 태평양 시간을 확인했어요...' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages).toHaveBeenNthCalledWith(1, expect.objectContaining({ usageScope: 'agent' }));
    const secondPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(secondPrompt).toContain('"toolName":"time.in_zone"');
    expect(secondPrompt).toContain('America/New_York');
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'tool', event: 'tool_call', toolName: 'time.in_zone' }),
      expect.objectContaining({ stage: 'tool', event: 'observation', toolName: 'time.in_zone' }),
      expect.objectContaining({ stage: 'agent', event: 'final' })
    ]));
    expect(store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'))?.slots.timeZones).toEqual([
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles'
    ]);
  });

  it('feeds prior time-zone context into a follow-up turn', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'east', tool: 'time.in_zone', input: { timeZone: 'America/New_York', label: '동부' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '동부 시간이예요...' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '이전 4군데 기준으로 답할게요...' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '동부 시간 알려줘', makeOptions());
    await runtime.run(makeMessage(), '그 4군데만 다시 말해봐', makeOptions());

    const followUpPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(followUpPrompt).toContain('이전 agent 문맥 JSON');
    expect(followUpPrompt).toContain('America/New_York');
  });

  it('blocks mixed action/read tool requests and executes none of them', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [
            { id: 'time', tool: 'time.viewer', input: {} },
            { id: 'cleanup', tool: 'command.cleanup', input: { count: 10 } }
          ]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '섞인 실행 요청이라 아무 작업도 하지 않았어요...', blockedTools: ['command.cleanup'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '지금 시간 알려주고 채팅 10개 지워줘', makeOptions());

    expect(outcome).toEqual({ kind: 'blocked', message: '섞인 실행 요청이라 아무 작업도 하지 않았어요...', blockedTools: ['command.cleanup'] });
    const secondPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(secondPrompt).toContain('Mixed action/read request is blocked');
    expect(secondPrompt).not.toContain('timestampTag');
  });

  it('runs history.search through the registered read-only handler', async () => {
    const diagnostics: unknown[] = [];
    const historySearch = vi.fn(async () => ({
      scope: 'server',
      query: '짬뽕지존',
      scannedChannels: 1,
      matchedMessages: 1,
      usedMessages: 1,
      evidence: [{ channelId: 'channel-1', authorName: '테스터', timestamp: '2026-05-22T18:00:00.000Z', content: '짬뽕지존 얘기' }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'search', tool: 'history.search', input: { scope: 'server', query: '짬뽕지존', mode: 'summary' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '짬뽕지존 얘기가 있었어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '대화 내용 중에 짬뽕지존 찾아봐', makeOptions({ onDiagnostic: (event: unknown) => diagnostics.push(event) }));

    expect(outcome).toEqual({ kind: 'final', message: '짬뽕지존 얘기가 있었어요...' });
    expect(historySearch).toHaveBeenCalledWith(
      { scope: 'server', query: '짬뽕지존', mode: 'summary', channelRef: undefined, limit: undefined },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('짬뽕지존 얘기');
    const observationDiagnostic = diagnostics.find((event) => (event as { event?: string; toolName?: string }).event === 'observation' && (event as { toolName?: string }).toolName === 'history.search') as { observationSummary?: string };
    expect(observationDiagnostic.observationSummary).toContain('evidenceCount');
    expect(observationDiagnostic.observationSummary).not.toContain('짬뽕지존 얘기');
  });

  it('routes mistaken blocked voice-speak decisions to the existing legacy speak command', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'blocked',
        message: '음성 채널에 들어와서 말하기는 현재 차단된 기능입니다.',
        blockedTools: ['voice.speak']
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '일단 음성채널에 들어와서 아무말이나 해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '말 초코코봇 테스트 중이에요' });
  });

  it('keeps mixed read and voice requests blocked instead of rewriting to legacy command', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'blocked',
        message: '읽기랑 음성 실행이 섞여 있어요.',
        blockedTools: ['voice.speak']
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '미국 시간대 알려주고 음성으로 말해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'blocked', message: '읽기랑 음성 실행이 섞여 있어요.', blockedTools: ['voice.speak'] });
  });

});
