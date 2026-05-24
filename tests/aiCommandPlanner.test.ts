import { Collection } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { AiCommandPlanner, buildPlannerMessages, plannerLimits } from '../src/services/aiCommandPlanner.js';
import type { PrefixCommand } from '../src/types.js';

function makeMessage() {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    author: {
      id: 'user-1'
    }
  } as any;
}

function makeCommands(count = 1) {
  const commands = new Collection<string, PrefixCommand>();
  for (let index = 0; index < count; index += 1) {
    const command: PrefixCommand = {
      name: `명령${index}`,
      aliases: ['a', 'b', 'c', 'd', 'e', 'f'],
      description: 'x'.repeat(200),
      execute: vi.fn(async () => undefined)
    };
    commands.set(command.name, command);
  }
  return commands;
}

describe('AiCommandPlanner', () => {
  it('parses command plans returned by the model', async () => {
    const ai = {
      askMessages: vi.fn(async () => '{"kind":"command","query":"청소 100"}')
    };
    const planner = new AiCommandPlanner(ai as any);
    const commands = new Collection<string, PrefixCommand>([
      [
        '청소',
        {
          name: '청소',
          aliases: ['clean', 'clear'],
          description: 'delete own messages',
          execute: vi.fn(async () => undefined)
        }
      ]
    ]);

    const plan = await planner.plan(makeMessage(), '내 채팅 100개 지워줘', {
      prefix: '!',
      commands,
      availableChannels: [{ id: 'channel-1', name: 'general', mention: '<#channel-1>' }]
    });

    expect(plan).toEqual({ kind: 'command', query: '청소 100' });
    expect(ai.askMessages).toHaveBeenCalledTimes(1);
  });


  it('parses time plans returned by the model', async () => {
    const ai = {
      askMessages: vi.fn(async () => '{"kind":"time","target":"viewer","offsetSeconds":18000}')
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), '지금부터 5시간 후는 몇시야', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: []
    });

    expect(plan).toEqual({ kind: 'time', target: 'viewer', offsetSeconds: 18000, timeZone: undefined, label: undefined });
  });


  it('lets the model decide pending confirmation replies', async () => {
    const ai = {
      askMessages: vi.fn(async () => '{"kind":"confirm_pending"}')
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), 'ㅇ..', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: [],
      pendingConfirmation: { preview: '채널 메시지 삭제를 진행할까요?', commandQuery: '대청소 3', intent: 'cleanup', normalizedArgs: '3' }
    });

    expect(plan).toEqual({ kind: 'confirm_pending' });
    const firstCall = (ai.askMessages as any).mock.calls[0]?.[0] as { messages: Array<{ content: string }> } | undefined;
    expect(firstCall?.messages[0]?.content).toContain('대기 중인 확인 작업 JSON');
    expect(firstCall?.messages[0]?.content).toContain('짧은 긍정 답변');
  });

  it('retries invalid time zones from model output', async () => {
    const ai = {
      askMessages: vi.fn()
        .mockResolvedValueOnce('{"kind":"time","target":"zone","timeZone":"Hungary","label":"헝가리"}')
        .mockResolvedValueOnce('{"kind":"time","target":"zone","timeZone":"Europe/Budapest","label":"헝가리","offsetSeconds":0}')
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), '헝가리 몇시야', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: []
    });

    expect(plan).toEqual({ kind: 'time', target: 'zone', offsetSeconds: 0, timeZone: 'Europe/Budapest', label: '헝가리' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
  });

  it('returns chat when the model says the request is ordinary chat', async () => {
    const ai = {
      askMessages: vi.fn(async () => '{"kind":"chat"}')
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), '그냥 안녕', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: []
    });

    expect(plan).toEqual({ kind: 'chat' });
  });

  it('emits token and rate-limit metadata when detailed AI responses are available', async () => {
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi.fn(),
      askMessagesDetailed: vi.fn(async () => ({
        content: '{"kind":"chat"}',
        model: 'openai/gpt-oss-20b',
        usageScope: 'planner',
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
        rateLimitHeaders: { 'x-ratelimit-remaining-tokens': '7985' },
        status: 200
      }))
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), '그냥 안녕', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: [],
      onDiagnostic: (event) => { diagnostics.push(event); }
    });

    expect(plan).toEqual({ kind: 'chat' });
    expect(ai.askMessagesDetailed).toHaveBeenCalledTimes(1);
    expect(ai.askMessages).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'request',
        promptSnippet: expect.stringContaining('사용자 요청: 그냥 안녕')
      }),
      expect.objectContaining({
        event: 'response',
        model: 'openai/gpt-oss-20b',
        usageScope: 'planner',
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
        rateLimitHeaders: { 'x-ratelimit-remaining-tokens': '7985' },
        status: 200
      })
    ]));
  });

  it('retries invalid model output once with validation feedback', async () => {
    const diagnostics: unknown[] = [];
    const ai = {
      askMessages: vi.fn()
        .mockResolvedValueOnce('{"kind":"command","query":""}')
        .mockResolvedValueOnce('{"kind":"clarify","message":"채팅으로 답할까요, 음성으로 말할까요?"}')
    };
    const planner = new AiCommandPlanner(ai as any);

    const plan = await planner.plan(makeMessage(), '안녕이라고 말해봐', {
      prefix: '!',
      commands: new Collection(),
      availableChannels: [],
      onDiagnostic: (event) => { diagnostics.push(event); }
    });

    expect(plan).toEqual({ kind: 'clarify', message: '채팅으로 답할까요, 음성으로 말할까요?' });
    expect(ai.askMessages).toHaveBeenCalledTimes(2);
    const secondMessages = ai.askMessages.mock.calls[1][0].messages as Array<{ content: string }>;
    expect(secondMessages[0].content).toContain('재시도 지시');
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'parse_error' }), expect.objectContaining({ event: 'retry' })]));
  });

  it('keeps planner payloads within configured caps for relevant sections', () => {
    const limits = plannerLimits();
    const messages = buildPlannerMessages(makeMessage(), `${'가'.repeat(5000)} 최근 대화 요약하고 청소 명령도 확인해줘`, {
      prefix: '!',
      commands: makeCommands(40),
      availableChannels: Array.from({ length: 50 }, (_, index) => ({
        id: `channel-${index}`,
        name: `very-long-channel-name-${index}-${'x'.repeat(100)}`,
        mention: `<#channel-${index}>`
      }))
    });
    const system = messages[0].content;
    const user = messages[1].content;
    const commandLines = system.split('\n').filter((line) => line.startsWith('- 명령'));
    const channelLines = system.split('\n').filter((line) => line.startsWith('- <#channel-'));

    expect(system.length).toBeLessThanOrEqual(limits.maxSystemPromptChars);
    expect(system).toContain('없는 채널명은 만들지 말고 clarify');
    expect(system).toContain('특정 주제/단어/언급');
    expect(system).toContain('targetChannelReference="서버 전체"');
    expect(system).not.toContain('이전 채널 기록 요청: mode=');
    expect(user.length).toBeLessThanOrEqual(limits.maxPlannerPromptChars);
    expect(commandLines.length).toBeLessThanOrEqual(limits.maxCommands);
    expect(commandLines.every((line) => line.length <= limits.maxCommandLineChars)).toBe(true);
    expect(channelLines.length).toBeLessThanOrEqual(limits.maxChannels);
    expect(channelLines.every((line) => line.length <= limits.maxChannelLineChars)).toBe(true);
  });

  it('includes pending channel-history context for follow-up planning', () => {
    const messages = buildPlannerMessages(makeMessage(), '왜 없지? 짬뽕지존은?', {
      prefix: '!',
      commands: makeCommands(1),
      availableChannels: [{ id: 'delivery-1', name: '배달', mention: '<#delivery-1>' }],
      pendingHistory: { mode: 'summary', query: '짬뽕' }
    });

    expect(messages[0].content).toContain('이전 채널 기록 요청: mode=summary, query=짬뽕');
    expect(messages[1].content).toContain('짬뽕지존');
  });

  it('keeps ordinary chat planner prompts compact without prose-based section routing', () => {
    const messages = buildPlannerMessages(makeMessage(), '그냥 안녕 뭐해', {
      prefix: '!',
      commands: makeCommands(10),
      availableChannels: [{ id: 'channel-1', name: 'general', mention: '<#channel-1>' }]
    });

    const system = messages[0].content;

    expect(system).toContain('기능 판단 카드');
    expect(system).toContain('IANA timeZone');
    expect(system).toContain('참조 가능한 텍스트 채널');
    expect(system).not.toContain('그냥 안녕 뭐해');
    expect(system.length).toBeLessThan(4200);
  });

  it('does not change planner system guidance by scanning user prose', () => {
    const timeMessages = buildPlannerMessages(makeMessage(), '헝가리 몇시야', {
      prefix: '!',
      commands: makeCommands(1),
      availableChannels: [{ id: 'channel-1', name: 'general', mention: '<#channel-1>' }]
    });
    const historyMessages = buildPlannerMessages(makeMessage(), '최근 대화 요약해봐', {
      prefix: '!',
      commands: makeCommands(1),
      availableChannels: [{ id: 'channel-1', name: 'general', mention: '<#channel-1>' }]
    });

    expect(timeMessages[0].content).toEqual(historyMessages[0].content);
    expect(timeMessages[1].content).toBe('헝가리 몇시야');
    expect(historyMessages[1].content).toBe('최근 대화 요약해봐');
  });

});
