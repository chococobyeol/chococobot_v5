import 'dotenv/config';

export type Settings = {
  discordToken: string;
  groqApiKey: string;
  groqModel: string;
  aiSystemPrompt: string;
  aiMaxCompletionTokens: number;
  aiPlannerMaxCompletionTokens: number;
  aiUserDailyTokenLimit: number;
  aiGuildDailyTokenLimit: number;
  aiMemoryRecentTurns: number;
  aiMemoryCompactAfterTurns: number;
  aiMemoryMaxSummaryChars: number;
  botTimeZone: string;
  cleanMineDefaultTarget: number;
  cleanMineMaxLimit: number;
  cleanAllDefaultTarget: number;
  cleanAllMaxLimit: number;
  databasePath: string;
  loggingGuildId: string;
  voiceIdleLeaveMs: number;
  ttsEngine: string;
  ttsVoice: string;
  ttsMaxChars: number;
  ttsReadBotMessages: boolean;
  ttsVoicePresets: Readonly<Record<string, string>>;
  logLevel: string;
};

export const DEFAULT_TTS_VOICE_PRESETS: Readonly<Record<string, string>> = {
  sunhi: 'ko-KR-SunHiNeural',
  injoon: 'ko-KR-InJoonNeural',
  bright: 'ko-KR-SunHiNeural',
  calm: 'ko-KR-InJoonNeural'
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = intFromEnv(name, fallback);
  if (parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const parsed = intFromEnv(name, fallback);
  if (parsed < 0) throw new Error(`${name} must be zero or a positive integer`);
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

export function loadSettings(): Settings {
  return {
    discordToken: process.env.DISCORD_TOKEN ?? '',
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    aiSystemPrompt:
      process.env.AI_SYSTEM_PROMPT ??
      [
        '당신은 ChococoBot이에요. 짧고 다정한 한국어로 답해요.',
        '명령어 응답처럼 자연스럽게 말해요: 안녕하세요..., 채널에 이미 연결되어 있어요..., 음성 채널에 접속한 상태여야 해요...',
        '느낌표, 물음표, 이모지, 장식 문자는 쓰지 않아요. 문장 끝은 보통 ... 또는 해요로 마무리해요.',
        '인사만 받으면 안녕하세요...처럼 짧게 답하고, 어떤 도움이 필요하신가요 같은 상담봇 문구는 쓰지 않아요.',
        '상황에 맞는 자연스러운 답을 만들고, 확실하지 않으면 구체적으로 물어봐요.'
      ].join(' '),
    aiMaxCompletionTokens: positiveIntFromEnv('AI_MAX_COMPLETION_TOKENS', 500),
    aiPlannerMaxCompletionTokens: positiveIntFromEnv('AI_PLANNER_MAX_COMPLETION_TOKENS', 800),
    aiUserDailyTokenLimit: nonNegativeIntFromEnv('AI_USER_DAILY_TOKEN_LIMIT', 0),
    aiGuildDailyTokenLimit: positiveIntFromEnv('AI_GUILD_DAILY_TOKEN_LIMIT', 180_000),
    aiMemoryRecentTurns: positiveIntFromEnv('AI_MEMORY_RECENT_TURNS', 4),
    aiMemoryCompactAfterTurns: positiveIntFromEnv('AI_MEMORY_COMPACT_AFTER_TURNS', 12),
    aiMemoryMaxSummaryChars: positiveIntFromEnv('AI_MEMORY_MAX_SUMMARY_CHARS', 900),
    botTimeZone: process.env.BOT_TIME_ZONE ?? 'Asia/Seoul',
    cleanMineDefaultTarget: positiveIntFromEnv('CLEAN_MINE_DEFAULT_TARGET', 500),
    cleanMineMaxLimit: positiveIntFromEnv('CLEAN_MINE_MAX_LIMIT', 500),
    cleanAllDefaultTarget: positiveIntFromEnv('CLEAN_ALL_DEFAULT_TARGET', 1000),
    cleanAllMaxLimit: positiveIntFromEnv('CLEAN_ALL_MAX_LIMIT', 1000),
    databasePath: process.env.DATABASE_PATH ?? 'data/chococobot.sqlite3',
    loggingGuildId: process.env.LOGGING_GUILD_ID ?? '1507058598423826533',
    voiceIdleLeaveMs: positiveIntFromEnv('VOICE_IDLE_LEAVE_MS', 10 * 60 * 1000),
    ttsEngine: process.env.TTS_ENGINE ?? 'edge',
    ttsVoice: process.env.TTS_VOICE ?? 'ko-KR-SunHiNeural',
    ttsMaxChars: positiveIntFromEnv('TTS_MAX_CHARS', 500),
    ttsReadBotMessages: boolFromEnv('TTS_READ_BOT_MESSAGES', false),
    ttsVoicePresets: DEFAULT_TTS_VOICE_PRESETS,
    logLevel: process.env.LOG_LEVEL ?? 'info'
  };
}

export function assertRuntimeSettings(settings: Settings): void {
  const missing: string[] = [];
  if (!settings.discordToken) missing.push('DISCORD_TOKEN');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (!settings.loggingGuildId) throw new Error('LOGGING_GUILD_ID is required');
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone: settings.botTimeZone }).format(new Date());
  } catch {
    throw new Error('BOT_TIME_ZONE must be a valid IANA time zone, for example Asia/Seoul');
  }
  if (!['edge', 'gtts'].includes(settings.ttsEngine.toLowerCase())) {
    throw new Error('TTS_ENGINE must be one of: edge, gtts');
  }
  if (settings.cleanMineDefaultTarget > settings.cleanMineMaxLimit) {
    throw new Error('CLEAN_MINE_DEFAULT_TARGET must be less than or equal to CLEAN_MINE_MAX_LIMIT');
  }
  if (settings.cleanAllDefaultTarget > settings.cleanAllMaxLimit) {
    throw new Error('CLEAN_ALL_DEFAULT_TARGET must be less than or equal to CLEAN_ALL_MAX_LIMIT');
  }
}
