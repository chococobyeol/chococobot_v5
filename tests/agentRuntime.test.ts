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
