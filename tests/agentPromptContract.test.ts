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

describe('AgentRuntime prompt contract', () => {
  it('keeps the Stage 2 system prompt generic and contract-oriented', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '도구 계약 프롬프트를 확인해줘', makeOptions());

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('반드시 JSON 객체 하나만 출력하세요');
    expect(prompt).toContain('도구 계약: AI는 의미를 판단해 허용 출력 중 하나를 고르고');
    expect(prompt).toContain('tool_calls');
    expect(prompt).toContain('schema/policy/safety/loop');
    expect(prompt).toContain('도구 관찰값이 있으면 not_handled로 넘기지 말고');
    expect(prompt).toContain('이미 성공한 같은 입력의 도구는 다시 호출하지 말고');
    expect(prompt).toContain('일반 대화처럼 도구가 필요 없으면 not_handled');
    expect(prompt).toContain('runtime.context');
    expect(prompt).toContain('history.search');
    expect(prompt).toContain('voice.speak');
    expect(prompt).toContain('tarot.start_reading');
    expect(prompt).toContain('tarot.reveal_selection');
    expect(prompt).toContain('requester_voice_channel_not_bot_location');
    expect(prompt).toContain('literal quote from current/stored user text');
    expect(prompt).toContain('channel-wide cleanup has no evidence field');
    expect(prompt).not.toContain('ctx.userVoice는 사용자의 음성 채널이고 봇의 위치가 아니에요');
    expect(prompt).not.toContain('cleanup evidence는 내부 안전 근거예요');
    expect(prompt).not.toContain('지원 prefix 명령:');
    expect(prompt).not.toContain('{"kind":"legacy_command","query":"..."}');
    expect(prompt.length).toBeLessThan(5400);
  });

  it('keeps the output envelope contract before truncatable channel/tool context', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());
    const availableChannels = Array.from({ length: 40 }, (_, index) => ({
      id: `channel-${index}`,
      name: `긴채널이름-${index}-${'가'.repeat(20)}`,
      mention: `<#channel-${index}>`
    }));

    await runtime.run(makeMessage(), '배달 채널 내용 요약해봐', makeOptions({ availableChannels }));

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('top-level field는 반드시 kind');
    expect(prompt).toContain('허용 kind');
    expect(prompt).toContain('provider/native tool call');
    expect(prompt).toContain('{"kind":"not_handled"}');
    expect(prompt).toContain('{"kind":"tool_calls"');
    expect(prompt).toContain('history.search');
    expect(prompt).toContain("mode: 'qa'|'summary'");
  });

  it('does not hide runtime tool schemas by scanning ordinary chat prose', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '그냥 안녕', makeOptions());

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('history.search');
    expect(prompt).toContain('runtime.context [read_only_auto] input={}');
    expect(prompt).toContain("history.search [read_only_auto] input={ scope: 'server'|'channel'");
    expect(prompt).toContain('voice.speak [safe_action_auto] input={ text: string }');
    expect(prompt).not.toContain('그냥 안녕');
  });

  it('does not reintroduce long migrated-feature legacy_command exception blocks', async () => {
    const ai = { askMessages: vi.fn().mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' })) };
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry(), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '프롬프트 금지 문구를 확인해줘', makeOptions());

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain('음성 말하기도 단 하나의 명확한 기존 말 명령이면');
    expect(prompt).not.toContain('자동 입장 가능한 기존 "말 <문장>" 명령 하나');
    expect(prompt).not.toContain('프리픽스 변경, TTS 채널 설정, 웹 검색 모드 설정, 기억삭제');
    expect(prompt).not.toContain('그냥 "채팅 3개"처럼 대상이 생략되면');
    expect(prompt).not.toContain('cleanupEvidence는 사용자 말이나 이전 clarify 후속');
    expect(prompt).not.toContain('{"kind":"legacy_command","query":"말 안녕"}');
    expect(prompt).not.toContain('{"kind":"legacy_command","query":"청소 3"');
  });

  it('includes compact active tarot session context without adding semantic router prose', async () => {
    const ai = {
      askMessages: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ kind: 'not_handled' }))
        .mockResolvedValueOnce(JSON.stringify({ kind: 'final', message: '관찰값 기준으로 해석했어요.' }))
    };
    const tarotRevealSelection = vi.fn(async () => ({
      message: '연애운 타로 카드 3장을 확인했어요.',
      topic: '연애운',
      spreadCount: 3,
      selectedNumbers: [1, 2, 3],
      cards: [],
      visualData: { bars: '흐름 ▰▰▰▱▱' }
    }));
    const runtime = new AgentRuntime(ai as any, createDefaultToolRegistry({ tarotRevealSelection }), new AgentTurnContextStore());

    await runtime.run(makeMessage(), '1 2 3', makeOptions({
      tarotPending: { topic: '연애운', spreadCount: 3, spreadName: '세 장 흐름', expiresAt: Date.parse('2026-05-22T18:25:00.000Z') }
    }));

    const prompt = ai.askMessages.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('tarotPending');
    expect(prompt).toContain('연애운');
    expect(prompt).toContain('tarot.reveal_selection');
    expect(prompt).toContain('"selectedNumbers":[1,2,3]');
    expect(prompt).not.toContain('타로라는 단어가 있으면');
    expect(prompt.length).toBeLessThan(5400);
  });

});
