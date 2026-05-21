import Groq from 'groq-sdk';
import type { Settings } from '../config.js';
import type { UsageStore } from './usageStore.js';

export class AiLimitError extends Error {}

export type AiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiUsageScope = 'chat' | 'summary';

export class AiService {
  private readonly groq: Groq;

  constructor(
    private readonly settings: Settings,
    private readonly usageStore: UsageStore
  ) {
    this.groq = new Groq({ apiKey: settings.groqApiKey });
  }

  async ask(params: { guildId: string; userId: string; prompt: string }): Promise<string> {
    return this.askMessages({
      guildId: params.guildId,
      userId: params.userId,
      messages: [
        { role: 'system', content: this.settings.aiSystemPrompt },
        { role: 'user', content: params.prompt }
      ]
    });
  }

  async askMessages(params: {
    guildId: string;
    userId: string;
    messages: AiChatMessage[];
    usageScope?: AiUsageScope;
  }): Promise<string> {
    const scope = params.usageScope ?? 'chat';
    const guildUsage = this.usageStore.summarizeGuild(params.guildId, 1);
    if (scope === 'chat') {
      const userUsage = this.usageStore.summarizeUser(params.guildId, params.userId, 1);
      if (userUsage.totalTokens >= this.settings.aiUserDailyTokenLimit) {
        throw new AiLimitError('오늘 개인 AI 토큰 한도를 이미 사용했어요...');
      }
    }
    if (guildUsage.totalTokens >= this.settings.aiGuildDailyTokenLimit) {
      throw new AiLimitError('오늘 서버 AI 토큰 한도를 이미 사용했어요...');
    }

    const completion = await this.groq.chat.completions.create({
      model: this.settings.groqModel,
      max_completion_tokens: this.settings.aiMaxCompletionTokens,
      messages: params.messages
    });

    const usage = completion.usage;
    this.usageStore.recordAiUsage({
      guildId: params.guildId,
      userId: scope === 'summary' ? '__maintenance__' : params.userId,
      model: this.settings.groqModel,
      usageScope: scope,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0
    });

    return completion.choices[0]?.message?.content?.trim() || '응답이 비어 있어요...';
  }
}
