import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/services/agentRuntime.js';
import { AgentTurnContextStore } from '../src/services/agentTurnContextStore.js';
import { AgentToolExecutionError, createDefaultToolRegistry } from '../src/services/toolRegistry.js';

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
  it('recovers safe status/action aliases for non-tool envelopes without retrying', async () => {
    const statusAi = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ status: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const actionAi = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ action: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };

    const statusRuntime = new AgentRuntime(statusAi as any, createDefaultToolRegistry(), new AgentTurnContextStore());
    const actionRuntime = new AgentRuntime(actionAi as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await expect(statusRuntime.run(makeMessage(), '안녕', makeOptions())).resolves.toEqual({ kind: 'not_handled' });
    await expect(actionRuntime.run(makeMessage(), '안녕', makeOptions())).resolves.toEqual({ kind: 'not_handled' });
    expect(statusAi.askMessages).toHaveBeenCalledTimes(1);
    expect(actionAi.askMessages).toHaveBeenCalledTimes(1);
  });

  it('accepts nested final and clarify envelopes that small models often emit', async () => {
    const clarifyAi = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'clarify',
        clarify: {
          message: '어떤 주제로 타로를 볼까요?',
          pendingAction: { kind: 'tarot', originalPrompt: '타로봐줘', missing: ['topic'] }
        }
      }))
    };
    const finalAi = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'final',
        final: { message: '이전 대화 기준으로 답할게요.' }
      }))
    };

    await expect(new AgentRuntime(clarifyAi as any, createDefaultToolRegistry(), new AgentTurnContextStore()).run(makeMessage(), '타로봐줘', makeOptions()))
      .resolves.toEqual({
        kind: 'clarify',
        message: '어떤 주제로 타로를 볼까요?',
        pendingAction: { kind: 'tarot', originalPrompt: '타로봐줘', missing: ['topic'] }
      });
    await expect(new AgentRuntime(finalAi as any, createDefaultToolRegistry(), new AgentTurnContextStore()).run(makeMessage(), '이어 말해줘', makeOptions({ conversationContext: '이전 대화' })))
      .resolves.toEqual({ kind: 'final', message: '이전 대화 기준으로 답할게요.' });
  });

  it('repairs common tarot spread count aliases before tool schema validation', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '이따 병원갈까',
      spreadCount: 3,
      selection: { min: 1, max: 78, count: 3, unique: true }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '이따 병원갈까', count: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '‘이따 병원갈까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '이따 병원갈까', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '‘이따 병원갈까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' });
    expect(tarotStartReading).toHaveBeenCalledWith({ topic: '이따 병원갈까', spreadCount: 3 }, expect.any(Object));
  });

  it('does not recover status/action aliases into executable tool calls', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'channel-1',
      query: '',
      scannedChannels: 1,
      matchedMessages: 1,
      usedMessages: 1,
      evidence: [{ channelId: 'channel-1', authorName: '테스터', timestamp: '2026-05-22T18:00:00.000Z', content: '배달 이야기' }]
    }));
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          status: 'tool_calls',
          calls: [{ id: 'history', tool: 'history.search', input: { scope: 'channel', channelRef: 'channel-1', query: '', mode: 'summary' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '연애운', spreadCount: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '연애운', spreadCount: 3 } }]
        }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    await expect(runtime.run(makeMessage(), '배달 채널 내용 요약해봐', makeOptions({ onDiagnostic: (event: unknown) => diagnostics.push(event) }))).resolves.toEqual({ kind: 'not_handled' });

    expect(historySearch).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'parse_error', validationErrors: expect.arrayContaining(['Unknown kind: (missing)']) })
    ]));
  });

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
    expect(secondPrompt).toContain('final 스타일: 한국어 초코코봇 말투');
    expect(secondPrompt).toContain('짧고 자연스럽게 답해요');
    expect(secondPrompt).toContain('문장 끝에 해요나 ...를 접미어처럼 억지로 덧붙이지 마세요');
    expect(secondPrompt).not.toContain('... 또는 해요');
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

  it('keeps history context after a no-tool follow-up answer so short retries can reuse the topic', async () => {
    const historySearch = vi.fn(async () => ({
      scope: 'channel',
      channelId: 'delivery',
      query: '초밥',
      scannedChannels: 1,
      matchedMessages: 0,
      usedMessages: 0,
      evidence: []
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'history-1', tool: 'history.search', input: { scope: 'channel', channelRef: 'delivery', query: '초밥', mode: 'qa' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '배달 채널에서는 초밥 관련 내용을 찾지 못했어요...' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '해당 채널에도 초밥 관련 내용이 없어요...' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '어떤 내용을 찾을까요...' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), store);

    await runtime.run(makeMessage(), '배달 채널에서 초밥 찾아봐', makeOptions({
      availableChannels: [{ id: 'delivery', name: '배달', mention: '<#delivery>' }]
    }));
    await runtime.run(makeMessage(), '다른 채널에서 찾아볼까', makeOptions());
    await runtime.run(makeMessage(), '여기서 찾아', makeOptions());

    const retryPrompt = ai.askMessages.mock.calls[3][0].messages[0].content;
    expect(retryPrompt).toContain('이전 agent 문맥 JSON');
    expect(retryPrompt).toContain('"topic":"초밥"');
    expect(retryPrompt).toContain('해당 채널에도 초밥 관련 내용이 없어요');
  });


  it('labels user voice separately from the bot voice connection in agent context', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '니가 있는곳', makeOptions({
      userVoiceChannel: { id: 'voice-user', name: '음성테스트' },
      botVoiceConnected: false,
      botVoiceChannel: null
    }));

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain('ctx.userVoice는 사용자의 음성 채널이고 봇의 위치가 아니에요');
    expect(prompt).toContain('requester_voice_channel_not_bot_location');
    expect(prompt).toContain('botVoiceConnected_and_botVoiceChannel_are_bot_location_source_of_truth');
    expect(prompt).toContain('"botVoiceConnected":false');
    expect(prompt).toContain('"botVoiceChannel":null');
    expect(prompt).toContain('음성테스트');
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

  it('retries empty blocked decisions so setting requests go through the confirmation tool path', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'blocked',
          message: '해당 작업은 권한이 필요합니다',
          blockedTools: []
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'ai-channel', tool: 'settings.ai_channel', input: { action: 'set', channelRef: 'channel-1' } }]
        }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '이 채널 ai 대화채널로 설정해봐', makeOptions());

    expect(outcome).toMatchObject({
      kind: 'confirmation_required',
      intent: 'settings.ai_channel',
      commandQuery: 'ai채널 channel-1'
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    const retryPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(retryPrompt).toContain('blockedTools에 실제 구조화 도구 이름이 있어야 해요');
    expect(retryPrompt).toContain('코드의 확인/권한 경로가 처리');
  });

  it('allows contextual final answers when shared conversation memory is present', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'final',
        message: '방금 말한 곳은 제가 연결된 음성 채널이라는 뜻이에요...'
      }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    const outcome = await runtime.run(makeMessage(), '어떤 음성채널인데', makeOptions({
      conversationContext: 'user(테스터, <#channel-1>): 니가 있는곳\nassistant: 저는 현재 음성 채널에 연결돼 있어요...'
    }));

    expect(outcome).toEqual({ kind: 'final', message: '방금 말한 곳은 제가 연결된 음성 채널이라는 뜻이에요...' });
    const firstPrompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(firstPrompt).toContain('conversation=');
    expect(firstPrompt).toContain('저는 현재 음성 채널에 연결돼 있어요');
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
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain("query may be empty only when mode='summary'");
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
    expect(firstPrompt).toContain('필수 구조화 필드가 부족하면 clarify');
    expect(firstPrompt).toContain('history.search [read_only_auto]');
    expect(firstPrompt).toContain('\"mention\":\"<#channel-1>\"');
    expect(firstPrompt).toContain('\"name\":\"general\"');
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
          calls: [{ id: 'history-2', tool: 'history.search', input: { scope: 'server', query: '최근 대화', mode: 'summary', limit: 20 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '읽은 메시지 기준으로 봇 응답 품질에 대한 불만이 있었어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySearch }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '대화 내용이나 요약해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '읽은 메시지 기준으로 봇 응답 품질에 대한 불만이 있었어요...' });
    expect(historySearch).toHaveBeenCalledTimes(1);
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('이미 같은 입력의 도구 성공 관찰값이 있어요');
    expect(repairPrompt).toContain('반복 도구: history.search');
    expect(repairPrompt).toContain('이미 성공한 같은 입력의 도구를 다시 호출하지 말고');
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
    expect(observationPrompt).toContain('도구 관찰 JSON:');
    expect(observationPrompt).toContain('짬뽕지존 홍대점');
    const retryPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(retryPrompt).toContain('재시도 지시:');
    expect(retryPrompt).toContain('이미 성공한 같은 입력의 도구를 다시 호출하지 말고');
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
    expect(firstPrompt).toContain('\"mode\":\"search_first_factual\"');
    expect(firstPrompt).toContain('source title/url list');
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
          calls: [{ id: 'web-2', tool: 'web.search', input: { query: '짬뽕지존', count: 3, language: 'ko' } }]
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
    expect(repairPrompt).toContain('이미 같은 입력의 도구 성공 관찰값이 있어요');
    expect(repairPrompt).toContain('반복 도구: web.search');
    expect(repairPrompt).toContain('이미 성공한 같은 입력의 도구를 다시 호출하지 말고');
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
    expect(followUpPrompt).toContain('이전 agent 문맥 JSON');
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
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('search first for current/external/verifiable factual questions');
  });


  it('keeps web-search intent decisions out of regex/prose classifiers', () => {
    const source = readFileSync(new URL('../src/services/agentRuntime.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('isExplicitWebSearchPrompt');
    expect(source).not.toMatch(/웹\\s\*검색.*검색해.*최신.*뉴스/s);
    expect(source).toContain('explicit factual/search needs unavailable');
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
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('\"providerStatus\":\"missing_config\"');
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('explicit factual/search needs unavailable');
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

  it('retries not_handled with prior web-search context before falling back', async () => {
    const store = new AgentTurnContextStore();
    const firstAi = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'unavailable',
        reason: 'web_search_unavailable',
        message: '웹 검색 서버 주소가 설정되지 않아 확인할 수 없어요...'
      }))
    };
    const firstRuntime = new AgentRuntime(firstAi as any, createDefaultToolRegistry(), store);

    await firstRuntime.run(makeMessage(), '정성카츠 주소를 인터넷에 찾아봐', makeOptions({
      webSearch: { mode: 'automatic', provider: 'searxng', providerStatus: 'missing_config', resultCount: 3 }
    }));

    const diagnostics: unknown[] = [];
    const followUpAi = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '방금 말한 건 SearXNG 서버 주소가 설정되지 않았다는 뜻이에요...' }))
    };
    const followUpRuntime = new AgentRuntime(followUpAi as any, createDefaultToolRegistry(), store);

    const outcome = await followUpRuntime.run(makeMessage(), '왜 비활성화돼있지?', makeOptions({
      webSearch: { mode: 'automatic', provider: 'searxng', providerStatus: 'missing_config', resultCount: 3 },
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({ kind: 'final', message: '방금 말한 건 SearXNG 서버 주소가 설정되지 않았다는 뜻이에요...' });
    expect(followUpAi.askMessages).toHaveBeenCalledTimes(2);
    const retryPrompt = followUpAi.askMessages.mock.calls[1][0].messages[0].content;
    expect(retryPrompt).toContain('직전 봇 응답: 웹 검색 서버 주소가 설정되지 않아 확인할 수 없어요...');
    expect(retryPrompt).toContain('"providerStatus":"missing_config"');
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'retry', decisionKind: 'prior_context_follow_up_required' })
    ]));
  });

  it('executes voice.speak through the common tool path', async () => {
    const voiceSpeak = vi.fn(async () => ({ message: '음성으로 말했어요...', text: '안녕', autoJoined: true, channelId: 'voice-1' }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'speak', tool: 'voice.speak', input: { text: '안녕' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '음성으로 말했어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ voiceSpeak }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '음성채널에 들어와서 안녕이라고 말해', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '음성으로 말했어요...' });
    expect(voiceSpeak).toHaveBeenCalledWith(
      { text: '안녕' },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"toolName":"voice.speak"');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"policy":"safe_action_auto"');
  });

  it('executes voice.join, voice.stop, and voice.leave through the common tool path', async () => {
    const voiceJoin = vi.fn(async () => ({ message: '음성 채널에 연결했어요...', channelId: 'voice-1' }));
    const voiceStop = vi.fn(async () => ({ message: '재생을 멈췄어요...', stopped: true }));
    const voiceLeave = vi.fn(async () => ({ message: '음성 채널에서 나왔어요...' }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [
            { id: 'join', tool: 'voice.join', input: {} },
            { id: 'stop', tool: 'voice.stop', input: {} },
            { id: 'leave', tool: 'voice.leave', input: {} }
          ]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '음성 연결, 멈춤, 해제를 처리했어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ voiceJoin, voiceStop, voiceLeave }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '들어왔다가 멈추고 나가', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '음성 연결, 멈춤, 해제를 처리했어요...' });
    expect(voiceJoin).toHaveBeenCalledTimes(1);
    expect(voiceStop).toHaveBeenCalledTimes(1);
    expect(voiceLeave).toHaveBeenCalledTimes(1);
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"voice.join"');
    expect(observationPrompt).toContain('"toolName":"voice.stop"');
    expect(observationPrompt).toContain('"toolName":"voice.leave"');
  });

  it('falls back from successful voice observations instead of requiring another route', async () => {
    const voiceSpeak = vi.fn(async () => ({ message: '음성으로 말했어요...', text: '안녕', autoJoined: false, channelId: 'voice-1' }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'speak', tool: 'voice.speak', input: { text: '안녕' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ voiceSpeak }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '안녕이라고 말해', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: expect.stringContaining('작업 관찰값 기준') });
    expect(voiceSpeak).toHaveBeenCalledTimes(1);
  });

  it('executes requester TTS and time preference tools through the common tool path', async () => {
    const ttsVoicePreset = vi.fn(async () => ({ message: '내 TTS 음색을 sunhi로 저장했어요...', current: 'sunhi', available: ['sunhi'] }));
    const ttsEngine = vi.fn(async () => ({ message: '내 TTS 엔진을 edge로 저장했어요...', current: 'edge', available: ['edge', 'gtts'] }));
    const userTimezone = vi.fn(async () => ({ message: '내 시간대를 Asia/Seoul로 저장했어요...', current: 'Asia/Seoul', defaultTimeZone: 'Asia/Seoul' }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [
            { id: 'voice-preset', tool: 'tts.voice_preset', input: { action: 'set', preset: 'sunhi' } },
            { id: 'engine', tool: 'tts.engine', input: { action: 'set', engine: 'edge' } },
            { id: 'timezone', tool: 'time.user_timezone', input: { action: 'set', timeZone: 'Asia/Seoul' } }
          ]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '개인 TTS와 시간대 설정을 저장했어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ ttsVoicePreset, ttsEngine, userTimezone }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 음색 sunhi, tts엔진 edge, 시간대 Asia/Seoul로 설정해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '개인 TTS와 시간대 설정을 저장했어요...' });
    expect(ttsVoicePreset).toHaveBeenCalledWith({ action: 'set', preset: 'sunhi' }, expect.anything());
    expect(ttsEngine).toHaveBeenCalledWith({ action: 'set', engine: 'edge' }, expect.anything());
    expect(userTimezone).toHaveBeenCalledWith({ action: 'set', timeZone: 'Asia/Seoul' }, expect.anything());
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"tts.voice_preset"');
    expect(observationPrompt).toContain('"toolName":"tts.engine"');
    expect(observationPrompt).toContain('"toolName":"time.user_timezone"');
  });

  it('returns structured voice.speak validation errors for missing text', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'speak', tool: 'voice.speak', input: {} }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '무슨 말을 할까요...' }))
    };
    const voiceSpeak = vi.fn();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ voiceSpeak }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '말해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'clarify', message: '무슨 말을 할까요...' });
    expect(voiceSpeak).not.toHaveBeenCalled();
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"voice.speak"');
    expect(observationPrompt).toContain('"code":"validation_error"');
    expect(observationPrompt).toContain('"field":"text"');
  });



  it('returns cleanup confirmation observations through the common tool path', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'tool_calls',
        calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 3, evidence: '내 채팅' } }]
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 3개 지워줘', makeOptions());

    expect(outcome).toMatchObject({
      kind: 'confirmation_required',
      intent: 'command.cleanup',
      commandQuery: '청소 3',
      payload: { target: 'self', count: 3, evidence: '내 채팅' }
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
  });

  it('feeds cleanup validation errors back as structured observations', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 0 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '몇 개를 지울까요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 지워줘', makeOptions());

    expect(outcome).toEqual({ kind: 'clarify', message: '몇 개를 지울까요...' });
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"command.cleanup"');
    expect(observationPrompt).toContain('"code":"validation_error"');
    expect(observationPrompt).toContain('"field":"count"');
  });


  it('keeps migrated tools in the tool-only runtime without legacy repair routing', () => {
    const source = readFileSync(new URL('../src/services/agentRuntime.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('LEGACY_ACTION_TOOL_NAMES');
    expect(source).not.toContain('buildLegacyActionDecisionFeedback');
    expect(source).not.toContain('legacy_command');
    expect(source).not.toContain('isToolBackedMigratedCommandQuery');
    expect(source).toContain('validateToolCallSafety');
  });

  it('does not repair migrated cleanup blocks into legacy commands', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'blocked',
        message: '채팅 삭제는 구조화된 도구 확인으로만 처리해요...',
        blockedTools: ['command.cleanup']
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 10개 지워줘', makeOptions());

    expect(outcome).toEqual({
      kind: 'blocked',
      message: '채팅 삭제는 구조화된 도구 확인으로만 처리해요...',
      blockedTools: ['command.cleanup']
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
  });

  it('does not repair migrated settings or memory blocks into legacy commands', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '설정 변경은 구조화된 도구 확인으로만 처리해요...', blockedTools: ['settings.prefix'] }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '기억삭제는 구조화된 도구 확인으로만 처리해요...', blockedTools: ['memory.delete'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await expect(runtime.run(makeMessage(), '프리픽스 ~로 바꿔줘', makeOptions())).resolves.toEqual({ kind: 'blocked', message: '설정 변경은 구조화된 도구 확인으로만 처리해요...', blockedTools: ['settings.prefix'] });
    await expect(runtime.run(makeMessage(), '서버 AI 기억 초기화해줘', makeOptions())).resolves.toEqual({ kind: 'blocked', message: '기억삭제는 구조화된 도구 확인으로만 처리해요...', blockedTools: ['memory.delete'] });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('uses structured cleanup tools for migrated cleanup requests', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'tool_calls',
        calls: [{ id: 'cleanup', tool: 'command.mass_cleanup', input: { target: 'channel', count: 5 } }]
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '전체 채팅 5개 지워줘', makeOptions());

    expect(outcome).toMatchObject({
      kind: 'confirmation_required',
      intent: 'command.mass_cleanup',
      commandQuery: '대청소 5'
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
  });


  it('asks the model to generate a clarifying question for cleanup prompts without a count or scope', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
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
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('필수 구조화 필드가 부족하면 clarify');
  });



  it('asks who to delete when counted cleanup omits the target', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'clarify',
        message: '누구 채팅 3개를 지울까요? 본인 메시지라면 내꺼라고 말해 주세요.'
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '누구 채팅 3개를 지울까요? 본인 메시지라면 내꺼라고 말해 주세요.' });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('필수 구조화 필드가 부족하면 clarify');
  });


  it('does not trust cleanupTarget self when the prompt has no explicit requester evidence', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 3, evidence: '내 채팅' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '누구 채팅 3개를 지울까요?' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '누구 채팅 3개를 지울까요?' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('도구 호출 안전 검증');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('command.cleanup');
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"field":"evidence"');
  });

  it('returns a structured confirmation for explicit requester cleanup tools', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'tool_calls',
        calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 3, evidence: '내 채팅' } }]
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내 채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({
      kind: 'confirmation_required',
      intent: 'command.cleanup',
      commandQuery: '청소 3',
      payload: { target: 'self', count: 3, evidence: '내 채팅' }
    });
  });

  it('does not allow another user cleanup to be rewritten as requester cleanup', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '특정 다른 사람 메시지만 지우는 기능은 지원하지 않아요.', blockedTools: ['command.cleanup'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '다른 사람 채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'blocked', message: '특정 다른 사람 메시지만 지우는 기능은 지원하지 않아요.', blockedTools: ['command.cleanup'] });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup clarification context so short follow-up answers can become structured cleanup confirmations', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '테스터님 메시지를 지울까요, 아니면 채널 전체를 지울까요? 몇 개를 지울지도 알려 주세요.'
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 3, evidence: '내꺼' } }]
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '채팅 3개 지워봐', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '내꺼', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({ kind: 'confirmation_required', commandQuery: '청소 3' });
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
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.mass_cleanup', input: { target: 'channel', count: 5 } }]
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '채팅 지워봐', makeOptions({ requesterDisplayName: '테스터' }));
    await runtime.run(makeMessage(), '전체', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '5', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({ kind: 'confirmation_required', commandQuery: '대청소 5' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('"originalPrompt":"채팅 지워봐"');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('"target":"channel"');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('"missing":["count"]');
  });


  it('rejects cleanup clarify turns that ask the user for internal evidence', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '몇 개를 지울까요?',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '여기 채팅 다 지워봐',
            target: 'channel',
            missing: ['count']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '증거를 알려줘',
          pendingAction: {
            kind: 'cleanup',
            originalPrompt: '여기 채팅 다 지워봐',
            target: 'channel',
            count: 100,
            missing: ['evidence']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.mass_cleanup', input: { target: 'channel', count: 100 } }]
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '여기 채팅 다 지워봐', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '100개', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({ kind: 'confirmation_required', commandQuery: '대청소 100' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('cleanup missing may only include target/count');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('must not ask for evidence');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('never ask user for evidence');
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
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'cleanup', tool: 'command.cleanup', input: { target: 'self', count: 5, evidence: '내 채팅' } }]
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '내 채팅 지워줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '5', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({ kind: 'confirmation_required', commandQuery: '청소 5' });
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
      kind: 'clarify',
      message: '누구 채팅을 몇 개 지울까요?',
      pendingAction: {
        kind: 'cleanup',
        originalPrompt: '메세지 삭제 해봐',
        target: 'ambiguous',
        missing: ['target', 'count']
      }
    });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
  });



  it('returns settings and memory confirmation requests through the common tool path', async () => {
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({
        kind: 'tool_calls',
        calls: [{ id: 'prefix', tool: 'settings.prefix', input: { action: 'set', prefix: '~' } }]
      }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '프리픽스를 바꿔줘', makeOptions());

    expect(outcome).toMatchObject({
      kind: 'confirmation_required',
      intent: 'settings.prefix',
      commandQuery: '프리픽스 ~'
    });
  });

  it('feeds settings validation errors back as structured observations', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'tts', tool: 'settings.tts_channel', input: { action: 'set' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '어느 채널로 설정할까요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), 'tts 채널 설정해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'clarify', message: '어느 채널로 설정할까요...' });
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"settings.tts_channel"');
    expect(observationPrompt).toContain('"code":"validation_error"');
    expect(observationPrompt).toContain('"field":"channelRef"');
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
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('pendingConfirmation=');
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('명확한 승인일 때만 confirm_pending');
  });

  it('rejects confirm_pending when no pending confirmation exists', async () => {
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'confirm_pending' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), 'ai채널 설정해줘', makeOptions({ onDiagnostic: (event: unknown) => diagnostics.push(event) }));

    expect(outcome).toEqual({ kind: 'not_handled' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'retry', decisionKind: 'spurious_confirm_pending' })
    ]));
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('confirm_pending은 사용할 수 없어요');
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


  it('does not re-execute repeated time.in_zone calls and steers the model to answer from the existing observation', async () => {
    const diagnostics: unknown[] = [];
    const repeatedCall = {
      kind: 'tool_calls',
      calls: [{ id: 'seoul', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
    };
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'seoul-again', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '서울 시간 관찰값 기준으로 답할게요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '서울 지금 몇 시야', makeOptions({
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({ kind: 'final', message: '서울 시간 관찰값 기준으로 답할게요...' });
    expect(diagnostics.filter((event) => (event as { event?: string; toolName?: string }).event === 'tool_call' && (event as { toolName?: string }).toolName === 'time.in_zone')).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'retry', decisionKind: 'tool_observation_already_available' })
    ]));
    const repairPrompt = ai.askMessages.mock.calls[2][0].messages[0].content;
    expect(repairPrompt).toContain('반복 도구: time.in_zone');
    expect(repairPrompt).toContain('이미 성공한 같은 입력의 도구를 다시 호출하지 말고');
  });

  it('allows the same read-only tool with different structured input', async () => {
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'seoul', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'new-york', tool: 'time.in_zone', input: { timeZone: 'America/New_York', label: '뉴욕' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '서울과 뉴욕 시간을 확인했어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '서울이랑 뉴욕 지금 몇 시야', makeOptions({
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({ kind: 'final', message: '서울과 뉴욕 시간을 확인했어요...' });
    expect(diagnostics.filter((event) => (event as { event?: string; toolName?: string }).event === 'tool_call' && (event as { toolName?: string }).toolName === 'time.in_zone')).toHaveLength(2);
  });

  it('does not re-execute repeated safe-action tools with the same input', async () => {
    const voiceSpeak = vi.fn(async () => ({ message: '음성으로 말했어요...', text: '안녕', autoJoined: false, channelId: 'voice-1' }));
    const repeatedCall = {
      kind: 'tool_calls',
      calls: [{ id: 'speak', tool: 'voice.speak', input: { text: '안녕' } }]
    };
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'speak-again', tool: 'voice.speak', input: { text: '안녕' } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '이미 음성으로 말했어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ voiceSpeak }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '안녕이라고 말해', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '이미 음성으로 말했어요...' });
    expect(voiceSpeak).toHaveBeenCalledTimes(1);
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('반복 도구: voice.speak');
  });

  it('feeds unknown tools back as structured observations instead of parser errors', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'missing', tool: 'missing.tool', input: {} }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '등록되지 않은 도구예요...', blockedTools: ['missing.tool'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '없는 도구 호출해봐', makeOptions());

    expect(outcome).toEqual({ kind: 'blocked', message: '등록되지 않은 도구예요...', blockedTools: ['missing.tool'] });
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"missing.tool"');
    expect(observationPrompt).toContain('"code":"unknown_tool"');
  });

  it('falls back from time observations when the model repeats after retry feedback', async () => {
    const repeatedCall = {
      kind: 'tool_calls',
      calls: [{ id: 'seoul', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
    };
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
        .mockResolvedValueOnce(JSON.stringify(repeatedCall))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '서울 지금 몇 시야', makeOptions());

    expect(outcome).toEqual({
      kind: 'final',
      message: expect.stringContaining('확인한 시간 관찰값 기준')
    });
    expect(outcome.kind === 'final' ? outcome.message : '').toContain('서울');
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
  });

  it('uses successful time observations as fallback after repeated parse errors', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'seoul', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } }]
        }))
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce('still not json')
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '서울 지금 몇 시야', makeOptions());

    expect(outcome).toEqual({
      kind: 'final',
      message: expect.stringContaining('확인한 시간 관찰값 기준')
    });
    expect(outcome.kind === 'final' ? outcome.message : '').toContain('서울');
  });

  it('feeds structured validation observations with field and hint back to the model', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'bad-web', tool: 'web.search', input: { query: '', count: 99 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'unavailable', reason: 'web_search_unavailable', message: '웹 검색 입력을 고쳐야 해요...' }))
    };
    const webSearch = vi.fn();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ webSearch }), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '웹 검색해줘', makeOptions({
      webSearch: { mode: 'explicit_only', provider: 'searxng', providerStatus: 'ready', resultCount: 3 }
    }));

    expect(webSearch).not.toHaveBeenCalled();
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"web.search"');
    expect(observationPrompt).toContain('"code":"validation_error"');
    expect(observationPrompt).toContain('"field":"query"');
    expect(observationPrompt).toContain('"hint":"Fix the structured input field');
  });

  it('turns mixed read/action tool calls into structured blocked observations without executing tools', async () => {
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [
            { id: 'time', tool: 'time.in_zone', input: { timeZone: 'Asia/Seoul', label: '서울' } },
            { id: 'speak', tool: 'voice.speak', input: { text: '안녕' } }
          ]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'blocked', message: '읽기와 실행 요청이 섞여 있어 처리하지 않았어요...', blockedTools: ['voice.speak'] }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '서울 시간 알려주고 안녕이라고 말해', makeOptions({
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({ kind: 'blocked', message: '읽기와 실행 요청이 섞여 있어 처리하지 않았어요...', blockedTools: ['voice.speak'] });
    expect(diagnostics.filter((event) => (event as { stage?: string; event?: string }).stage === 'tool' && (event as { event?: string }).event === 'tool_call')).toHaveLength(0);
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"code":"mixed_tool_request"');
    expect(observationPrompt).toContain('no tools were executed');
  });

  it('runs history.summarize through the same common observation loop with structured output', async () => {
    const historySummarize = vi.fn(async () => ({ message: '배달 채널에서는 짬뽕지존 가격 이야기가 있었어요.' }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'summary', tool: 'history.summarize', input: { query: '짬뽕지존', mode: 'summary', messages: [{ content: '짬뽕지존 가격' }] } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '짬뽕지존 가격 이야기가 있었어요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ historySummarize }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '이 기록을 요약해줘', makeOptions());

    expect(outcome).toEqual({ kind: 'final', message: '짬뽕지존 가격 이야기가 있었어요...' });
    expect(historySummarize).toHaveBeenCalledWith(
      { query: '짬뽕지존', mode: 'summary', messages: [{ content: '짬뽕지존 가격' }], searchRef: undefined },
      expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') })
    );
    const observationPrompt = ai.askMessages.mock.calls[1][0].messages[0].content;
    expect(observationPrompt).toContain('"toolName":"history.summarize"');
    expect(observationPrompt).toContain('"status":"ok"');
    expect(observationPrompt).toContain('배달 채널에서는 짬뽕지존 가격 이야기가 있었어요.');
  });

  it('keeps tarot pending action context so numeric follow-ups can reveal selected cards', async () => {
    const tarotRevealSelection = vi.fn(async () => ({
      message: '선택한 카드 3장을 확인했어요...',
      topic: '연애운',
      spreadCount: 3,
      selectedNumbers: [1, 2, 3],
      cards: [],
      visualData: { bars: '흐름 ▰▰▰▱▱' }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '연애운은 3장으로 볼게요. 1부터 78 사이 숫자 3개를 골라주세요.',
          pendingAction: {
            kind: 'tarot',
            originalPrompt: '연애운 봐줘',
            topic: '연애운',
            spreadCount: 3,
            missing: ['numbers']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'reveal', tool: 'tarot.reveal_selection', input: { numbers: [1, 2, 3] } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '연애운 흐름은 차분히 가까워지는 쪽이에요...' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), store);

    await runtime.run(makeMessage(), '연애운 봐줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '1 2 3', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({ kind: 'final', message: expect.stringContaining('연애운') });
    expect(tarotRevealSelection).toHaveBeenCalledWith({ numbers: [1, 2, 3] }, expect.objectContaining({ nowMs: Date.parse('2026-05-22T18:15:00.000Z') }));
    expect(ai.askMessages).toHaveBeenCalledTimes(4);
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('이전 pendingAction JSON');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('tarot.reveal_selection');
  });

  it('does not return cleanup-specific copy when an unresolved tarot pending action remains', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '오늘 운세는 1장으로 볼게요. 숫자 1개를 골라주세요.',
          pendingAction: {
            kind: 'tarot',
            originalPrompt: '오늘 운세 봐줘',
            topic: '오늘 운세',
            spreadCount: 1,
            missing: ['numbers']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), store);

    await runtime.run(makeMessage(), '오늘 운세 봐줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '아무거나', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '오늘 운세는 1장으로 볼게요. 숫자 1개를 골라주세요.',
      pendingAction: {
        kind: 'tarot',
        originalPrompt: '오늘 운세 봐줘',
        topic: '오늘 운세',
        spreadCount: 1,
        missing: ['numbers']
      }
    });
    expect(JSON.stringify(outcome)).not.toContain('메시지 삭제');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('타로 pendingAction.missing에 numbers가 있으면');
  });

  it('rejects decimal tarot card selections before splitting them into extra cards', async () => {
    const ai = { askMessages: vi.fn() };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '2 32.1 5', makeOptions({
      tarotPending: { topic: '이따 병원갈지', spreadCount: 3, requesterDisplayName: '테스터' }
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '카드 번호는 소수나 음수 없이 정수로 골라주세요. 1~78 사이 숫자 3개를 중복 없이 골라주세요. 예: 1 23 45'
    });
    expect(ai.askMessages).not.toHaveBeenCalled();
  });

  it('uses a user-safe tarot interpretation fallback when the model fails after reveal', async () => {
    const tarotRevealSelection = vi.fn(async () => ({
      message: '이따 병원갈지 타로 카드 3장을 확인했어요.',
      topic: '이따 병원갈지',
      spreadCount: 3,
      selectedNumbers: [2, 5, 1],
      cards: [
        { selectionNumber: 2, nameKo: '여사제', orientation: 'reversed', orientationKo: '역방향', keywords: ['직감', '비밀', '관찰'], assetPath: 'assets/tarot/tarot_high_priestess.png', attachmentName: 'tarot-2.png' },
        { selectionNumber: 5, nameKo: '컵 기사', orientation: 'upright', orientationKo: '정방향', keywords: ['추진', '이동'], assetPath: 'assets/tarot/tarot_cups_knight.png', attachmentName: 'tarot-5.png' },
        { selectionNumber: 1, nameKo: '펜타클 기사', orientation: 'reversed', orientationKo: '역방향', keywords: ['현실', '관리'], assetPath: 'assets/tarot/tarot_pentacles_knight.png', attachmentName: 'tarot-1.png' }
      ],
      visualData: { bars: '흐름 ▰▰▰▱▱ 3/5\n감정 ▰▰▰▰▱ 4/5\n행동 ▰▰▰▱▱ 3/5' },
      presentation: {
        title: '이따 병원갈지 타로',
        summary: '흐름 ▰▰▰▱▱ 3/5',
        files: [{ path: 'assets/tarot/tarot_high_priestess.png', name: 'tarot-2.png' }],
        cards: [{ selectionNumber: 2, name: '여사제', orientation: '역방향', attachmentName: 'tarot-2.png' }]
      }
    }));
    const ai = { askMessages: vi.fn().mockResolvedValueOnce('응답이 비어 있어요...') };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '2 5 1', makeOptions({
      tarotPending: { topic: '이따 병원갈지', spreadCount: 3, requesterDisplayName: '테스터' }
    }));

    expect(outcome.kind).toBe('final');
    expect(JSON.stringify(outcome)).not.toContain('해석해 주세요');
    expect(outcome.kind === 'final' ? outcome.message : '').not.toContain('카드\n');
    expect(outcome.kind === 'final' ? outcome.message : '').not.toContain('흐름 ▰');
    expect(JSON.stringify(outcome)).toContain('의료진 안내');
    expect(JSON.stringify(outcome)).toContain('여사제');
  });

  it('asks for a tarot topic first when the request has no subject, then starts a spread from the follow-up', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '연애운',
      spreadCount: 3,
      selection: { min: 1, max: 78, count: 3, unique: true }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '무엇에 대해 타로를 볼까요?',
          pendingAction: {
            kind: 'tarot',
            originalPrompt: '타로 봐줘',
            missing: ['topic']
          }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '연애운', spreadCount: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '‘연애운’을 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), store);

    await expect(runtime.run(makeMessage(), '타로 봐줘', makeOptions({ requesterDisplayName: '테스터' }))).resolves.toEqual({
      kind: 'clarify',
      message: '무엇에 대해 타로를 볼까요?',
      pendingAction: {
        kind: 'tarot',
        originalPrompt: '타로 봐줘',
        missing: ['topic']
      }
    });
    const outcome = await runtime.run(makeMessage(), '연애운', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '‘연애운’을 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' });
    expect(tarotStartReading).toHaveBeenCalledWith({ topic: '연애운', spreadCount: 3 }, expect.any(Object));
    expect(ai.askMessages).toHaveBeenCalledTimes(4);
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('clarify 질문에 대한 후속 답변');
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('tarot.start_reading');
  });

  it('returns trusted tarot presentation metadata with the final interpretation', async () => {
    const tarotRevealSelection = vi.fn(async () => ({
      message: '선택한 카드 1장을 확인했어요...',
      topic: '오늘 운세',
      spreadCount: 1,
      selectedNumbers: [7],
      cards: [{ selectionNumber: 7, nameKo: '전차', nameEn: 'The Chariot', orientation: 'upright', assetPath: 'assets/tarot/07-TheChariot.png', attachmentName: 'tarot-07-TheChariot.png' }],
      visualData: { bars: '흐름 ▰▰▰▰▱' },
      presentation: {
        title: '오늘 운세 타로',
        summary: '흐름 ▰▰▰▰▱',
        files: [{ path: 'assets/tarot/07-TheChariot.png', name: 'tarot-07-TheChariot.png' }],
        cards: [{ selectionNumber: 7, name: '전차', orientation: '정방향', attachmentName: 'tarot-07-TheChariot.png' }]
      }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'reveal', tool: 'tarot.reveal_selection', input: { numbers: [7] } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '오늘은 앞으로 밀고 나가는 힘이 좋아요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '7', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toMatchObject({
      kind: 'final',
      message: '오늘은 앞으로 밀고 나가는 힘이 좋아요...',
      presentation: expect.objectContaining({
        files: [{ path: 'assets/tarot/07-TheChariot.png', name: 'tarot-07-TheChariot.png' }],
        summary: expect.stringContaining('흐름')
      })
    });
  });


  it('lets the model phrase the tarot start observation instead of displaying tool copy', async () => {
    const tarotStartReading = vi.fn(async () => ({ topic: '연애운', spreadCount: 3, selection: { min: 1, max: 78, count: 3, unique: true } }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '연애운', spreadCount: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '1~78 사이 숫자 3개를 골라주세요.' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '연애운 타로 봐줘', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '1~78 사이 숫자 3개를 골라주세요.' });
    expect(ai.askMessages).toHaveBeenCalledTimes(3);
    expect(tarotStartReading).toHaveBeenCalledTimes(1);
  });

  it('starts a tarot reading for a fully specified lunch-choice prompt', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '내일 점심 뭐먹을지',
      spreadCount: 3,
      selection: { min: 1, max: 78, count: 3, unique: true }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '내일 점심 뭐먹을지', spreadCount: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '‘내일 점심 뭐먹을지’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '내일 점심 뭐먹을지 타로 봐줘', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '‘내일 점심 뭐먹을지’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.'
    });
    expect(tarotStartReading).toHaveBeenCalledWith({ topic: '내일 점심 뭐먹을지', spreadCount: 3 }, expect.any(Object));
  });

  it('repairs tarot.start_reading cardCount aliases before exposing schema errors', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '밖에 나가는게 좋을까',
      spreadCount: 3,
      selection: { min: 1, max: 78, count: 3, unique: true }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'bad', tool: 'tarot.start_reading', input: { topic: '밖에 나가는게 좋을까', cardCount: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '‘밖에 나가는게 좋을까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' }))
    };
    const diagnostics: unknown[] = [];
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '밖에 나가는게 좋을까', makeOptions({
      requesterDisplayName: '테스터',
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '‘밖에 나가는게 좋을까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.'
    });
    expect(tarotStartReading).toHaveBeenCalledTimes(1);
    expect(tarotStartReading).toHaveBeenCalledWith({ topic: '밖에 나가는게 좋을까', spreadCount: 3 }, expect.any(Object));
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(outcome)).not.toContain('spreadCount must be an integer');
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'retry', decisionKind: 'tool_input_correction_required' })
    ]));
  });

  it('does not accept a plain final answer when a tarot topic follow-up must start the reading', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '이따 병원갈까',
      spreadCount: 3,
      selection: { min: 1, max: 78, count: 3, unique: true }
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '어떤 주제로 타로를 볼까요?',
          pendingAction: { kind: 'tarot', originalPrompt: '타로봐줘', missing: ['topic'] }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', final: { message: '건강은 전문가와 상의하는 것이 좋습니다.' } }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'tool_calls',
          calls: [{ id: 'start', tool: 'tarot.start_reading', input: { topic: '이따 병원갈까', count: 3 } }]
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'clarify', message: '‘이따 병원갈까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '타로봐줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '이따 병원갈까', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({ kind: 'clarify', message: '‘이따 병원갈까’를 3장으로 볼게요. 카드 번호는 1~78 사이에서 3개를 중복 없이 골라주세요.' });
    expect(JSON.stringify(outcome)).not.toContain('전문가와 상의');
    expect(tarotStartReading).toHaveBeenCalledWith({ topic: '이따 병원갈까', spreadCount: 3 }, expect.any(Object));
  });

  it('does not synthesize a tarot topic follow-up when the model keeps returning not_handled', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '저녁 뭐 먹을지',
      spreadCount: 3,
      message: '저녁 뭐 먹을지 주제로 3장 볼게요. 1~78 사이 숫자 3개를 중복 없이 골라주세요.'
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '무엇에 대해 타로를 볼까요?',
          pendingAction: { kind: 'tarot', originalPrompt: '타로 봐줘', missing: ['topic'] }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const diagnostics: unknown[] = [];
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), store);

    await runtime.run(makeMessage(), '타로 봐줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '저녁 뭐 먹을지', makeOptions({
      requesterDisplayName: '테스터',
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '무엇에 대해 타로를 볼까요?',
      pendingAction: { kind: 'tarot', originalPrompt: '타로 봐줘', missing: ['topic'] }
    });
    expect(tarotStartReading).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'retry', decisionKind: 'clarify_follow_up_required' })
    ]));
  });

  it('lets the model answer tarot topic recommendation meta-questions instead of starting a reading', async () => {
    const tarotStartReading = vi.fn(async () => ({
      topic: '잘못 시작됨',
      spreadCount: 3,
      message: '시작되면 안 돼요.'
    }));
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'clarify',
          message: '보고 싶은 주제를 알려주세요',
          pendingAction: { kind: 'tarot', originalPrompt: '다른거 봐줘', missing: ['topic'] }
        }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({
          kind: 'final',
          message: '한 장으로는 지금 제일 신경 쓰이는 일, 오늘 조심할 점, 지금 내 마음 같은 주제가 좋아요.'
        }))
    };
    const store = new AgentTurnContextStore();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotStartReading }), store);

    await runtime.run(makeMessage(), '다른거 봐줘', makeOptions({ requesterDisplayName: '테스터' }));
    const outcome = await runtime.run(makeMessage(), '카드 하나뽑을만한 주제 뭐있지', makeOptions({ requesterDisplayName: '테스터' }));

    expect(outcome).toEqual({
      kind: 'final',
      message: '한 장으로는 지금 제일 신경 쓰이는 일, 오늘 조심할 점, 지금 내 마음 같은 주제가 좋아요.'
    });
    expect(tarotStartReading).not.toHaveBeenCalled();
    expect(ai.askMessages.mock.calls[2][0].messages[0].content).toContain('메타질문이면 tool을 호출하지 말고 final로 예시를 추천하세요');
  });

  it('directly reveals active tarot numeric selections before asking the model for interpretation', async () => {
    const tarotRevealSelection = vi.fn(async () => ({
      message: '저녁 뭐 먹을지 타로 카드 3장을 확인했어요.',
      topic: '저녁 뭐 먹을지',
      spreadCount: 3,
      selectedNumbers: [1, 2, 3],
      cards: [],
      visualData: { bars: '흐름 ▰▰▰▱▱' }
    }));
    const ai = {
      askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '가볍고 따뜻한 메뉴가 좋아 보여요...' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '1 2 3', makeOptions({
      requesterDisplayName: '테스터',
      tarotPending: { topic: '저녁 뭐 먹을지', spreadCount: 3 }
    }));

    expect(tarotRevealSelection).toHaveBeenCalledWith({ numbers: [1, 2, 3] }, expect.any(Object));
    expect(outcome).toEqual({ kind: 'final', message: '가볍고 따뜻한 메뉴가 좋아 보여요...' });
    expect(ai.askMessages.mock.calls[0][0].messages[0].content).toContain('"toolName":"tarot.reveal_selection"');
  });

  it('treats a contiguous tarot number like 123 as one out-of-range card number', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValue(JSON.stringify({ kind: 'not_handled' })) };
    const tarotRevealSelection = vi.fn();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '123', makeOptions({
      requesterDisplayName: '테스터',
      tarotPending: { topic: '저녁 뭐 먹을지', spreadCount: 3 }
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '1~78 사이에서 골라주세요.'
    });
    expect(tarotRevealSelection).not.toHaveBeenCalled();
    expect(ai.askMessages).not.toHaveBeenCalled();
  });

  it('gives immediate feedback for non-numeric active tarot selections without asking the model', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValue(JSON.stringify({ kind: 'not_handled' })) };
    const tarotRevealSelection = vi.fn();
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '아무거나 골라줘', makeOptions({
      requesterDisplayName: '테스터',
      tarotPending: { topic: '저녁 뭐 먹을지', spreadCount: 3 }
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '숫자를 찾지 못했어요. 1~78 사이 숫자 3개를 중복 없이 골라주세요. 예: 1 23 45'
    });
    expect(tarotRevealSelection).not.toHaveBeenCalled();
    expect(ai.askMessages).not.toHaveBeenCalled();
  });

  it('returns tool feedback for duplicate or wrong-count active tarot selections', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValue(JSON.stringify({ kind: 'not_handled' })) };
    const tarotRevealSelection = vi.fn(async (input: { numbers: number[] }) => {
      if (input.numbers.length !== 3) {
        throw new AgentToolExecutionError('wrong_count', '3개만 골라주세요.', 'Retry with exactly 3 unique card numbers.', 'error', 'numbers');
      }
      return {
        message: '카드를 확인했어요.',
        topic: '저녁 뭐 먹을지',
        spreadCount: 3,
        selectedNumbers: input.numbers,
        cards: [],
        visualData: { bars: '흐름 ▰▰▰▱▱' }
      };
    });
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    await expect(runtime.run(makeMessage(), '1 1 2', makeOptions({
      requesterDisplayName: '테스터',
      tarotPending: { topic: '저녁 뭐 먹을지', spreadCount: 3 }
    }))).resolves.toEqual({
      kind: 'clarify',
      message: '중복된 숫자는 선택할 수 없어요. 서로 다른 번호를 골라주세요.'
    });

    await expect(runtime.run(makeMessage(), '1 2', makeOptions({
      requesterDisplayName: '테스터',
      tarotPending: { topic: '저녁 뭐 먹을지', spreadCount: 3 }
    }))).resolves.toEqual({
      kind: 'clarify',
      message: '3개만 골라주세요.'
    });
    expect(ai.askMessages).not.toHaveBeenCalled();
  });

  it('rejects malformed tarot clarify that asks for spreadCount and recovers to a topic-only question', async () => {
    const diagnostics: unknown[] = [];
    const invalidTarotClarify = {
      kind: 'clarify',
      message: '타로를 보려면 주제와 카드 개수를 알려주세요',
      pendingAction: {
        kind: 'tarot',
        originalPrompt: '타로봐줘',
        missing: ['topic', 'spreadCount']
      }
    };
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(invalidTarotClarify))
        .mockResolvedValueOnce(JSON.stringify(invalidTarotClarify))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
    };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    const outcome = await runtime.run(makeMessage(), '타로봐줘', makeOptions({
      requesterDisplayName: '테스터',
      onDiagnostic: (event: unknown) => diagnostics.push(event)
    }));

    expect(outcome).toEqual({
      kind: 'clarify',
      message: '무엇에 대해 타로를 볼까요?',
      pendingAction: {
        kind: 'tarot',
        originalPrompt: '타로봐줘',
        spreadCount: 3,
        missing: ['topic']
      }
    });
    expect(ai.askMessages.mock.calls[1][0].messages[0].content).toContain('tarot clarify may ask only for topic');
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'agent', event: 'parse_error', validationErrors: expect.arrayContaining([expect.stringContaining('tarot clarify may ask only for topic')]) }),
      expect.objectContaining({ stage: 'agent', event: 'retry', decisionKind: 'recovered_malformed_tarot_clarify' })
    ]));
  });

});
