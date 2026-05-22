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

  it('keeps planner payloads within configured caps', () => {
    const limits = plannerLimits();
    const messages = buildPlannerMessages(makeMessage(), '가'.repeat(5000), {
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
    expect(user.length).toBeLessThanOrEqual(limits.maxPlannerPromptChars);
    expect(commandLines.length).toBeLessThanOrEqual(limits.maxCommands);
    expect(commandLines.every((line) => line.length <= limits.maxCommandLineChars)).toBe(true);
    expect(channelLines.length).toBeLessThanOrEqual(limits.maxChannels);
    expect(channelLines.every((line) => line.length <= limits.maxChannelLineChars)).toBe(true);
  });
});
