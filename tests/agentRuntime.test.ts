import { readFileSync } from 'node:fs';
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
    commands: [
      { name: '말', aliases: ['say'], description: '음성 채널에서 읽기' },
      { name: '청소', aliases: ['clean'], description: '내가 쓴 최근 메시지를 삭제합니다.' },
      { name: '대청소', aliases: ['purge'], description: '관리자용: 최근 채팅을 삭제합니다.' }
    ],
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

  it('prompts tool-call answers to keep the bot conversation tone and stores context for follow-ups', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'seoul', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '서울은 지금 새벽 3시 15분이야. 다른 지역도 볼까...' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '서울 지금 몇 시야', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '서울은 지금 새벽 3시 15분이야. 다른 지역도 볼까...' });
    const secondPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(secondPrompt).toContain('관찰값을 본 뒤 한국어로 자연스럽게 final');
    expect(secondPrompt).toContain('사용자가 이어 말할 수 있는 한 가지 맥락');
    expect(secondPrompt).toContain('느낌표, 물음표, 이모지 없이 보통 ... 또는 해요');
    expect(store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'))).toMatchObject({
      lastAgentMessage: '서울은 지금 새벽 3시 15분이야. 다른 지역도 볼까...',
      slots: { timeZones: ['Asia/Seoul'] }
    });
  });

  it('does not rewrite tool-answer prose in code after the AI produces final JSON', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'viewer', tool: 'time.viewer', input: {} }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '지금은 <t:1779473700:t> 기준이야. 이어서 볼까?' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '지금 몇 시야', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '지금은 <t:1779473700:t> 기준이야. 이어서 볼까?' });
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

  it('does not accept final answers without tools or prior context from the bounded agent', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'final',
        message: '최근 대화 내용을 요약하면 요약 요청이 있었습니다.'
      }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '대화 내용 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'not_handled', reason: 'final_without_observation' });
    expect(store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'))).toBeUndefined();
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

  it('allows empty history.search query for recent conversation summaries', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'channel-1',
      query: '',
      scannedChannels: 1,
      matchedMessages: 2,
      usedMessages: 2,
      evidence: [
        { channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:00:00.000Z', content: 'hello' },
        { channelId: 'channel-1', authorName: 'ChococoBot', timestamp: '2026-05-22T18:01:00.000Z', content: '안녕하세요...' }
      ]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'recent', tool: 'history.search', input: { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary', limit: 50 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '최근 대화는 인사와 언어 요청 흐름이에요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '대화 내용이나 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '최근 대화는 인사와 언어 요청 흐름이에요...' });
    expect(historySearch).toHaveBeenCalledWith(
      { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary', limit: 50 },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('query=""');
  });

  it('grounds channel-summary requests in provided current-channel context before asking clarifying questions', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'channel-1',
      query: '',
      scannedChannels: 1,
      matchedMessages: 2,
      usedMessages: 2,
      evidence: [
        { channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:00:00.000Z', content: '!? 안녕' },
        { channelId: 'channel-1', authorName: 'ChococoBot', timestamp: '2026-05-22T18:01:00.000Z', content: '안녕하세요...' }
      ]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'current-channel', tool: 'history.search', input: { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '이 채널은 인사 테스트 흐름이 있었어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '이 채널 내용 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '이 채널은 인사 테스트 흐름이 있었어요...' });
    expect(historySearch).toHaveBeenCalledWith(
      { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary', limit: undefined },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    const firstPrompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(firstPrompt).toContain('제공된 현재 채널/서버 문맥으로 범위를 해소할 수 있으면 바로 tool_calls');
    expect(firstPrompt).toContain('정말 범위를 정할 근거가 없을 때만 pendingAction history가 포함된 clarify');
  });

  it('repairs a channel-summary clarify follow-up by steering the AI back to history.search', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'channel-1',
      query: '',
      scannedChannels: 1,
      matchedMessages: 1,
      usedMessages: 1,
      evidence: [{ channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:02:00.000Z', content: '이 채널 내용 요약해봐' }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '어떤 채널의 내용을 요약해드릴까요?' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'follow-up-channel', tool: 'history.search', input: { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '이 채널 내용 기준으로 요약했어요...' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), store);

    await runtime.run(makeMessage(), '이 채널 내용 요약해봐', makeOptions());
    const outcome = await runtime.run(makeMessage(), '아니 이채널...', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '이 채널 내용 기준으로 요약했어요...' });
    expect(historySearch).toHaveBeenCalledWith(
      { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary', limit: undefined },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('이전 clarify 질문: 어떤 채널의 내용을 요약해드릴까요?');
    expect(repairPrompt).toContain('현재 사용자 답변과 현재 채널/서버 문맥으로 범위를 해소해 history.search를 호출하세요');
  });

  it('does not fall through to chat when history observations exist and AI returns not_handled', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'server',
      query: '최근 대화',
      scannedChannels: 20,
      matchedMessages: 4,
      usedMessages: 4,
      evidence: [
        { channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:00:00.000Z', content: 'hello' },
        { channelId: 'channel-1', authorName: 'ChococoBot', timestamp: '2026-05-22T18:01:00.000Z', content: '안녕하세요...' },
        { channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:02:00.000Z', content: 'english please' }
      ]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'history', tool: 'history.search', input: { scope: 'server', query: '최근 대화', mode: 'summary', limit: 20 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '읽은 메시지 기준으로 인사와 영어 요청이 이어졌어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '대화 내용이나 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '읽은 메시지 기준으로 인사와 영어 요청이 이어졌어요...' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('도구 관찰값을 이미 받았기 때문에 not_handled를 사용할 수 없어요');
    expect(repairPrompt).toContain('대화 증거:');
    expect(repairPrompt).toContain('english please');
  });

  it('does not repeat history.search after a successful observation before finalizing', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'server',
      query: '최근 대화',
      scannedChannels: 20,
      matchedMessages: 1,
      usedMessages: 1,
      evidence: [{ channelId: 'channel-1', authorName: 'ㅊㅋㅂ', timestamp: '2026-05-22T18:02:00.000Z', content: '너 좀 멍청해진거같아' }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'history-1', tool: 'history.search', input: { scope: 'server', query: '최근 대화', mode: 'summary', limit: 20 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'history-2', tool: 'history.search', input: { scope: 'server', query: '최근 대화 내용', mode: 'summary', limit: 20 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '읽은 메시지 기준으로 봇 응답 품질에 대한 불만이 있었어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '대화 내용이나 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '읽은 메시지 기준으로 봇 응답 품질에 대한 불만이 있었어요...' });
    expect(historySearch).toHaveBeenCalledTimes(1);
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('이미 읽기 전용 도구 성공 관찰값이 있어요');
    expect(repairPrompt).toContain('반복 도구: history.search');
    expect(repairPrompt).toContain('이미 성공한 읽기 전용 도구를 다시 호출하지 말고');
  });

  it('falls back from evidence instead of looping when history.search is repeated after retry feedback', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'delivery',
      query: '짬뽕지존',
      scannedChannels: 1,
      matchedMessages: 1,
      usedMessages: 1,
      evidence: [
        {
          channelId: 'delivery',
          authorName: 'chocobyeol',
          timestamp: '2026-05-22T18:00:00.000Z',
          content: '짬뽕지존 홍대점은 지존짬뽕이 13000원이고 1000원에 500ml 제로펩시를 추가할 수 있다. 24시간 영업이 장점이다.'
        }
      ]
    }));
    const diagnostics: unknown[] = [];
    const repeatedCall = {
      kind: 'tool_calls',
      calls: [{ id: 'history', tool: 'history.search', input: { scope: 'channel', channelRef: 'delivery', query: '짬뽕지존', mode: 'qa' } }]
    };
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '배달 채널에서 짬뽕지존에 관한 내용 찾아봐', makeOptions({
      availableChannels: [{ id: 'delivery', name: '배달', mention: '<#delivery>' }],
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({
      kind: 'final',
      message: expect.stringContaining('짬뽕지존 홍대점은 지존짬뽕이 13000원')
    });
    expect(historySearch).toHaveBeenCalledTimes(1);
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt.indexOf('도구 관찰 JSON:')).toBeLessThan(observationPrompt.indexOf('너는 Discord 봇 ChococoBot'));
    expect(observationPrompt).toContain('짬뽕지존 홍대점');
    const retryPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(retryPrompt.indexOf('재시도 지시:')).toBeLessThan(retryPrompt.indexOf('너는 Discord 봇 ChococoBot'));
    expect(retryPrompt).toContain('이미 성공한 읽기 전용 도구를 다시 호출하지 말고');
    expect(retryPrompt).toContain('반복 도구: history.search');
    expect(retryPrompt).toContain('짬뽕지존 홍대점');
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'decision', decisionKind: 'observation_based_final' })
    ]));
  });

  it('runs web.search, asks for citations, and redacts web observations in diagnostics/context', async () => {
    const diagnostics: unknown[] = [];
    const webSearch = vi.fn(async () => ({
      provider: 'searxng' as const,
      query: 'SearXNG JSON API',
      results: [{
        title: 'SearXNG Search API',
        url: 'https://docs.searxng.org/dev/search_api.html',
        sourceDomain: 'docs.searxng.org',
        snippet: `safe snippet ${'x'.repeat(260)}`
      }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'web', tool: 'web.search', input: { query: 'SearXNG JSON API', count: 1 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: 'SearXNG는 JSON 검색 API를 제공해요... [1]\n출처: [1] SearXNG Search API — https://docs.searxng.org/dev/search_api.html' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), store);

    const outcome = await runtime.run(makeMessage(), 'SearXNG JSON API 최신 정보 검색해줘', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 },
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome.kind).toBe('final');
    expect(webSearch).toHaveBeenCalledWith(
      { query: 'SearXNG JSON API', count: 1, language: undefined, freshness: undefined },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    const firstPrompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(firstPrompt).toContain('mode=search_first_factual');
    expect(firstPrompt).toContain('출처: [1] 제목 — URL');
    const secondPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(secondPrompt).toContain('https://docs.searxng.org/dev/search_api.html');
    expect(secondPrompt).not.toContain('SearXNG JSON API');
    expect(secondPrompt).not.toContain('x'.repeat(220));
    const observationDiagnostic = diagnostics.find((event) => (event as { event?: string; toolName?: string }).event === 'observation' && (event as { toolName?: string }).toolName === 'web.search') as { observationSummary?: string };
    expect(observationDiagnostic.observationSummary).toContain('"results":1');
    expect(observationDiagnostic.observationSummary).not.toContain('SearXNG JSON API');
    expect(observationDiagnostic.observationSummary).not.toContain('safe snippet');
    const stored = store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'));
    expect(JSON.stringify(stored?.observations)).toContain('docs.searxng.org');
    expect(JSON.stringify(stored)).not.toContain('SearXNG JSON API');
    expect(stored?.lastUserPrompt).toBe('[redacted-web-search-prompt]');
    expect(JSON.stringify(stored?.observations)).not.toContain('x'.repeat(220));
  });

  it('does not repeat web.search after a successful observation before finalizing', async () => {
    const webSearch = vi.fn(async () => ({
      provider: 'searxng' as const,
      query: '짬뽕지존',
      results: [{
        title: '짬뽕지존 공식 웹사이트',
        url: 'https://jjamppongjijon.example/',
        sourceDomain: 'jjamppongjijon.example',
        snippet: '짬뽕 전문 프랜차이즈 소개'
      }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'web-1', tool: 'web.search', input: { query: '짬뽕지존', count: 3, language: 'ko' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'web-2', tool: 'web.search', input: { query: '짬뽕지존 공식', count: 3, language: 'ko' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'final',
          message: '검색 결과 기준으로 짬뽕지존은 짬뽕 전문 브랜드로 보여요... [1]\n출처: [1] 짬뽕지존 공식 웹사이트 — https://jjamppongjijon.example/'
        }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '인터넷에서 짬뽕지존 찾아봐', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));

    expect(outcome.kind).toBe('final');
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('이미 읽기 전용 도구 성공 관찰값이 있어요');
    expect(repairPrompt).toContain('반복 도구: web.search');
    expect(repairPrompt).toContain('이미 성공한 읽기 전용 도구를 다시 호출하지 말고');
    expect(repairPrompt).toContain('https://jjamppongjijon.example/');
  });

  it('returns source-only fallback instead of not_handled when web-search loop limit is reached', async () => {
    const diagnostics: unknown[] = [];
    const webSearch = vi.fn(async () => ({
      provider: 'searxng' as const,
      query: '짬뽕지존',
      results: [
        {
          title: '짬뽕지존 공식 웹사이트',
          url: 'https://jjamppongjijon.example/',
          sourceDomain: 'jjamppongjijon.example',
          snippet: '짬뽕 전문 프랜차이즈 소개'
        },
        {
          title: '짬뽕지존 메뉴',
          url: 'https://jjamppongjijon.example/menu',
          sourceDomain: 'jjamppongjijon.example',
          snippet: '메뉴 안내'
        }
      ]
    }));
    const repeatedSearch = JSON.stringify({
      kind: 'tool_calls',
      calls: [{ id: 'web', tool: 'web.search', input: { query: '짬뽕지존', count: 3, language: 'ko' } }]
    });
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValue(repeatedSearch)
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), store);

    const outcome = await runtime.run(makeMessage(), '인터넷에서 짬뽕지존 찾아봐', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 },
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({
      kind: 'final',
      message: expect.stringContaining('확인된 출처만 먼저 남길게요')
    });
    expect(outcome.kind === 'final' ? outcome.message : '').toContain('https://jjamppongjijon.example/');
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'decision', decisionKind: 'observation_based_final' })
    ]));
    const stored = store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'));
    expect(stored?.lastIntent).toBe('web_search');
    expect(stored?.lastUserPrompt).toBe('[redacted-web-search-prompt]');
    expect(JSON.stringify(stored?.observations)).toContain('jjamppongjijon.example');
  });

  it('feeds prior web-search sources into follow-up source requests', async () => {
    const webSearch = vi.fn(async () => ({
      provider: 'searxng' as const,
      query: '짬뽕지존',
      results: [{
        title: '짬뽕지존 공식 웹사이트',
        url: 'https://jjamppongjijon.example/',
        sourceDomain: 'jjamppongjijon.example',
        snippet: '짬뽕 전문 프랜차이즈 소개'
      }]
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'web', tool: 'web.search', input: { query: '짬뽕지존', count: 1, language: 'ko' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'final',
          message: '검색 결과 기준으로는 짬뽕지존 공식 사이트가 확인돼요... [1]\n출처: [1] 짬뽕지존 공식 웹사이트 — https://jjamppongjijon.example/'
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'final',
          message: '좀아까 검색 출처는 https://jjamppongjijon.example/ 이에요...'
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), store);

    await runtime.run(makeMessage(), '인터넷에서 짬뽕지존 찾아봐', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));
    const outcome = await runtime.run(makeMessage(), '좀아까 찾은거 출처 주소를 줘', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));

    expect(outcome.kind).toBe('final');
    const followUpPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(followUpPrompt).toContain('이전 agent 문맥 JSON');
    expect(followUpPrompt).toContain('이전 검색/이전 답변/출처/주소를 묻는 후속 질문');
    expect(followUpPrompt).toContain('https://jjamppongjijon.example/');
  });

  it('does not force web search for casual chat even when search-first mode is configured', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const webSearch = vi.fn(async () => ({ provider: 'searxng' as const, query: 'unused', results: [] }));
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '안녕 뭐해', makeOptions({
      webSearch: { mode: 'search_first_factual', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));

    expect(outcome).toEqual({ kind: 'not_handled' });
    expect(webSearch).not.toHaveBeenCalled();
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('잡담, 창작, 의견 요청');
  });


  it('keeps web-search intent decisions out of regex/prose classifiers', () => {
    const source = readFileSync(new URL('../src/services/agentRuntime.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('isExplicitWebSearchPrompt');
    expect(source).not.toMatch(/웹\\s\*검색.*검색해.*최신.*뉴스/s);
    expect(source).toContain('AI가 웹검색 필요 요청으로 판단했다면');
  });

  it('fails closed when a required web search provider call fails', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'web', tool: 'web.search', input: { query: '오늘 뉴스' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({
      webSearch: vi.fn(async () => { throw new Error('web search is unavailable in this runtime'); })
    }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '오늘 뉴스 검색해줘', makeOptions({
      webSearch: { mode: 'explicit_only', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));

    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'web_search_unavailable',
      message: expect.stringContaining('웹 검색 도구를 사용할 수 없어')
    });
  });

  it('does not override the model with keyword-based web-search classification when provider config is missing', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '최신 Node.js 소식 검색해줘', makeOptions({
      webSearch: { mode: 'automatic', provider: 'searxng', providerStatus: 'missing_config', resultCount: 3 }
    }));

    expect(outcome).toEqual({ kind: 'not_handled' });
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('providerStatus=missing_config');
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('AI가 웹검색 필요 요청으로 판단했다면');
    expect(store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'))).toBeUndefined();
  });

  it('redacts context when the model declares web search unavailable', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'unavailable',
        reason: 'web_search_unavailable',
        message: '웹 검색 서버 주소가 설정되지 않아 확인할 수 없어요...'
      }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '최신 Node.js 소식 검색해줘', makeOptions({
      webSearch: { mode: 'automatic', provider: 'searxng', providerStatus: 'missing_config', resultCount: 3 }
    }));

    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'web_search_unavailable',
      message: '웹 검색 서버 주소가 설정되지 않아 확인할 수 없어요...'
    });
    const stored = store.get({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }, Date.parse('2026-05-22T18:15:00.000Z'));
    expect(stored?.lastIntent).toBe('web_search');
    expect(stored?.lastUserPrompt).toBe('[redacted-web-search-prompt]');
    expect(JSON.stringify(stored)).not.toContain('최신 Node.js 소식');
  });

  it('asks the model to repair mistaken blocked voice-speak decisions into legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '음성 채널에 들어와서 말하기는 현재 차단된 기능입니다.',
          blockedTools: ['voice.speak']
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '말 초코코봇 테스트 중이에요' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '일단 음성채널에 들어와서 아무말이나 해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '말 초코코봇 테스트 중이에요' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('query는 지원 prefix 명령 목록의 명령/별칭과 인자를 사용해 직접 생성');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('자동 입장 가능한 기존 "말 <문장>" 명령 하나');
  });

  it('tells the model that join-and-speak is one speak command when text is clear', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '말 안녕' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '음성채널에 들어와서 안녕이라고 말해', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '말 안녕' });
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('기존 말 명령은 필요하면 먼저 사용자의 음성 채널에 자동 입장');
  });

  it('lets the model keep mixed read and voice requests blocked after a repair prompt', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '읽기랑 음성 실행이 섞여 있어요.',
          blockedTools: ['voice.speak']
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '읽기랑 음성 실행이 섞여 있어요.',
          blockedTools: ['voice.speak']
        }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '미국 시간대 알려주고 음성으로 말해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'blocked', message: '읽기랑 음성 실행이 섞여 있어요.', blockedTools: ['voice.speak'] });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps the safe blocked answer when a legacy-action repair retry returns invalid JSON', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '음성 채널에 들어가서 말하기는 한 번에 처리할 수 없어요.',
          blockedTools: ['voice.speak']
        }))
        .mockResolvedValueOnce('응답이 비어 있어요...')
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '음성채널에 들어와서 안녕이라고 말해', makeOptions());

    expect(outcome).toEqual({
      kind: 'blocked',
      message: '음성 채널에 들어가서 말하기는 한 번에 처리할 수 없어요.',
      blockedTools: ['voice.speak']
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });


  it('asks the model to repair explicit requester cleanup decisions into legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '채팅 삭제는 차단된 기능입니다.',
          blockedTools: ['command.cleanup']
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 10', cleanupTarget: 'self', cleanupEvidence: '내 채팅' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 10개 지워줘', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '청소 10', cleanupTarget: 'self', cleanupEvidence: '내 채팅' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('asks the model to repair mistaken blocked mass cleanup decisions into destructive legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '전체 채팅 삭제는 차단된 기능입니다.',
          blockedTools: ['command.mass_cleanup']
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '대청소 5', cleanupTarget: 'channel' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '전체 채팅 5개 지워줘', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '대청소 5', cleanupTarget: 'channel' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('asks the model to repair non-read-only cleanup tool calls into legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { count: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내 채팅' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 3개 지워줘', makeOptions());

    expect(outcome).toEqual({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내 채팅' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });


  it('asks the model to generate a clarifying question for cleanup prompts without a count or scope', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '채팅 삭제는 차단된 기능입니다.',
          blockedTools: ['command.cleanup']
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '테스터님 메시지를 지울까요, 아니면 채널 전체를 지울까요? 몇 개를 지울지도 알려 주세요.'
        }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '채팅 지워줘', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '테스터님 메시지를 지울까요, 아니면 채널 전체를 지울까요? 몇 개를 지울지도 알려 주세요.'
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('대상이 생략되면 요청자 본인 메시지라고 단정하지 마세요');
  });


  it('asks the model to repair other single confirmation-gated action blocks through legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '차단됨', blockedTools: ['settings.prefix'] }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '프리픽스 ~' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '차단됨', blockedTools: ['settings.tts_channel'] }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: 'tts채널' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '차단됨', blockedTools: ['memory.delete'] }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '기억삭제' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await expect(runtime.run(makeMessage(), '프리픽스 ~로 바꿔줘', makeOptions())).resolves.toEqual({ kind: 'legacy_command', query: '프리픽스 ~' });
    await expect(runtime.run(makeMessage(), '여기를 tts 채널로 설정해줘', makeOptions())).resolves.toEqual({ kind: 'legacy_command', query: 'tts채널' });
    await expect(runtime.run(makeMessage(), '서버 AI 기억 초기화해줘', makeOptions())).resolves.toEqual({ kind: 'legacy_command', query: '기억삭제' });
    expect(ai.askMessages).toHaveBeenCalledTimes(6);
  });


  it('asks who to delete when counted cleanup omits the target', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '누구 채팅 3개를 지울까요? 본인 메시지라면 내꺼라고 말해 주세요.' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '누구 채팅 3개를 지울까요? 본인 메시지라면 내꺼라고 말해 주세요.' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('그냥 "채팅 3개"처럼 대상이 생략되면');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('대상이 불명확하면 legacy_command를 내지 말고 clarify JSON으로 누구 채팅을 지울지 자연스럽게 물어보세요');
  });


  it('does not trust cleanupTarget self when the prompt has no explicit requester evidence', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '누구 채팅 3개를 지울까요?' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '누구 채팅 3개를 지울까요?' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('cleanupEvidence는 사용자 말이나 이전 clarify 후속에서 본인 메시지임을 드러내는 원문 일부를 그대로 복사');
  });

  it('allows explicit requester cleanup to become a legacy cleanup command', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내 채팅' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내 채팅' });
  });

  it('does not allow another user cleanup to be rewritten as requester cleanup', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'other' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '특정 다른 사람 메시지만 지우는 기능은 지원하지 않아요.', blockedTools: ['command.cleanup'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '다른 사람 채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'blocked', message: '특정 다른 사람 메시지만 지우는 기능은 지원하지 않아요.', blockedTools: ['command.cleanup'] });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps cleanup clarification context so short follow-up answers can become legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '테스터님 메시지를 지울까요, 아니면 채널 전체를 지울까요? 몇 개를 지울지도 알려 주세요.'
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내꺼' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '내꺼', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'legacy_command', query: '청소 3', cleanupTarget: 'self', cleanupEvidence: '내꺼' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('이전 agent 문맥 JSON');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('이전 사용자 요청: 채팅 3개 지워봐');
  });

  it('keeps AI-owned cleanup slots across multiple clarification turns', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '누구 채팅을 몇 개 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '채팅 지워봐',
            missing: ['target', 'count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '전체 채널에서 몇 개를 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '채팅 지워봐',
            target: 'channel',
            missing: ['count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '대청소 5', cleanupTarget: 'channel' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '채팅 지워봐', makeOptions({ requesterDisplayName: '테스터' }));
    await runtime.run(makeMessage(), '전체', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '5', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'legacy_command', query: '대청소 5', cleanupTarget: 'channel' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"originalPrompt":"채팅 지워봐"');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('"target":"channel"');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('"missing":["count"]');
  });

  it('keeps requester cleanup evidence in AI-owned slots until count is supplied', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '몇 개를 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '내 채팅 지워줘',
            target: 'self',
            cleanupEvidence: '내 채팅',
            missing: ['count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'legacy_command', query: '청소 5', cleanupTarget: 'self', cleanupEvidence: '내 채팅' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '내 채팅 지워줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '5', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'legacy_command', query: '청소 5', cleanupTarget: 'self', cleanupEvidence: '내 채팅' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"cleanupEvidence":"내 채팅"');
  });

  it('retries short cleanup follow-ups and lets AI block unsupported targets', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '누구 채팅을 몇 개 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '메세지 삭제 해봐',
            target: 'ambiguous',
            missing: ['target', 'count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '제 메시지만 따로 삭제하는 건 지원하지 않아요. 본인 메시지 삭제나 관리자용 전체 채널 삭제만 가능해요.',
          blockedTools: ['command.cleanup']
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '메세지 삭제 해봐', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '니 메세지', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'blocked',
      message: '제 메시지만 따로 삭제하는 건 지원하지 않아요. 본인 메시지 삭제나 관리자용 전체 채널 삭제만 가능해요.',
      blockedTools: ['command.cleanup']
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('지원하지 않는 대상의 메시지를 지우라는 의미라면 blocked JSON');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('not_handled는 쓰지 마세요');
  });

  it('does not fall through to chat when AI still returns not_handled for a pending cleanup action', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '누구 채팅을 몇 개 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '메세지 삭제 해봐',
            target: 'ambiguous',
            missing: ['target', 'count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '메세지 삭제 해봐', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '니 메세지', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'blocked',
      message: '메시지 삭제 요청의 대상이 아직 처리되지 않았어요. 제가 처리할 수 있는 건 요청자 본인 메시지 삭제나 관리자용 전체 채널 삭제뿐이에요.',
      blockedTools: ['command.cleanup']
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
  });


  it('uses AI to decide pending confirmation replies', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'confirm_pending' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), 'ㅇ..', makeOptions({
      pendingConfirmation: { preview: '채널 메시지 삭제를 진행할까요?', commandQuery: '대청소 3', intent: 'cleanup', normalizedArgs: '3' }
    }));

    expect(outcome).toEqual({ kind: 'confirm_pending' });
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('대기 중인 확인 작업 JSON');
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('짧은 긍정 답변');
  });

  it('retries not_handled pending confirmation replies through AI instead of code keywords', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'confirm_pending' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '그래', makeOptions({
      pendingConfirmation: { preview: '채널 메시지 삭제를 진행할까요?', commandQuery: '대청소 3', intent: 'cleanup', normalizedArgs: '3' }
    }));

    expect(outcome).toEqual({ kind: 'confirm_pending' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('사용자 답변의 의미를 판단');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('짧은 긍정');
  });

});
