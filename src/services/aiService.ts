import Groq, { APIError } from 'groq-sdk';
import type { Settings } from '../config.js';
import type { UsageStore } from './usageStore.js';

export class AiLimitError extends Error {}

export type AiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiUsageScope = 'chat' | 'summary' | 'planner';

export type RateLimitHeaders = Record<string, string>;

export type AiDetailedResponse = {
  content: string;
  model: string;
  usageScope: AiUsageScope;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  rateLimitHeaders: RateLimitHeaders;
  status?: number;
  requestId?: string;
};

const RATE_LIMIT_HEADER_NAMES = [
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens'
] as const;

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
    maxCompletionTokens?: number;
  }): Promise<string> {
    const detailed = await this.askMessagesDetailed(params);
    return detailed.content;
  }

  async askMessagesDetailed(params: {
    guildId: string;
    userId: string;
    messages: AiChatMessage[];
    usageScope?: AiUsageScope;
    maxCompletionTokens?: number;
  }): Promise<AiDetailedResponse> {
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

    const { data: completion, response } = await this.groq.chat.completions.create({
      model: this.settings.groqModel,
      max_completion_tokens: params.maxCompletionTokens ?? this.settings.aiMaxCompletionTokens,
      messages: params.messages
    }).withResponse();

    const usage = completion.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? 0;
    this.usageStore.recordAiUsage({
      guildId: params.guildId,
      userId: scope === 'summary' ? '__maintenance__' : params.userId,
      model: this.settings.groqModel,
      usageScope: scope,
      promptTokens,
      completionTokens,
      totalTokens
    });

    return {
      content: completion.choices[0]?.message?.content?.trim() || '응답이 비어 있어요...',
      model: completion.model || this.settings.groqModel,
      usageScope: scope,
      promptTokens,
      completionTokens,
      totalTokens,
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
      rateLimitHeaders: extractRateLimitHeaders(response.headers)
    };
  }
}

export function extractRateLimitHeaders(headers: Headers | undefined): RateLimitHeaders {
  const result: RateLimitHeaders = {};
  if (!headers) return result;
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

export function extractErrorDetails(error: unknown): { status?: number; errorName: string; errorMessage: string; rateLimitHeaders: RateLimitHeaders } {
  if (error instanceof APIError) {
    return {
      status: error.status,
      errorName: error.name,
      errorMessage: error.message,
      rateLimitHeaders: extractRateLimitHeaders(error.headers)
    };
  }
  if (error instanceof Error) {
    const statusValue = (error as unknown as { status?: unknown }).status;
    const maybeStatus = typeof statusValue === 'number' ? statusValue : undefined;
    return { status: maybeStatus, errorName: error.name, errorMessage: error.message, rateLimitHeaders: {} };
  }
  return { errorName: 'Error', errorMessage: String(error), rateLimitHeaders: {} };
}
