import type { ConfirmationIntent } from './confirmationManager.js';

export type RoutedNaturalLanguageCommand =
  | {
      kind: 'clarify';
      message: string;
    }
  | {
      kind: 'command';
      query: string;
    }
  | {
      kind: 'confirmation';
      intent: ConfirmationIntent;
      preview: string;
      query: string;
      normalizedArgs: string;
      targetChannelReference?: string;
    }
  | {
      kind: 'channel-history';
      mode: 'summary' | 'qa';
      targetChannelReference: string;
      query: string;
    };

export function routeNaturalLanguageCommand(content: string, prefix: string): RoutedNaturalLanguageCommand | null {
  const trigger = `${prefix}?`;
  const trimmed = content.trim();
  if (!trimmed.startsWith(trigger)) return null;

  const remainder = trimmed.slice(trigger.length).trim();
  if (!remainder) {
    return {
      kind: 'clarify',
      message: `${prefix}? 뒤에 질문이나 요청을 적어 주세요...`
    };
  }

  const commandRoute = routeDirectCommand(remainder);
  if (commandRoute) return commandRoute;

  const confirmationRoute = routeConfirmation(remainder);
  if (confirmationRoute) return confirmationRoute;

  const historyRoute = routeChannelHistory(remainder);
  if (historyRoute) return historyRoute;

  return null;
}

function routeDirectCommand(remainder: string): RoutedNaturalLanguageCommand | null {
  const token = firstToken(remainder);
  if (!token) return null;

  if (matchesAny(token.normalized, ['도움말', '명령어', 'help', 'commands', 'command', 'cmd'])) {
    return { kind: 'command', query: 'help' };
  }

  if (matchesAny(token.normalized, ['들어와', '이리와', 'join', 'come', '여기와', 'tts-join'])) {
    return { kind: 'command', query: '들어와' };
  }

  if (matchesAny(token.normalized, ['나가', '꺼져', '저리가', 'leave', 'go', 'out', '퇴장', 'tts-leave'])) {
    return { kind: 'command', query: '나가' };
  }

  if (matchesAny(token.normalized, ['말', 'say', 'speak', 'talk', 'read', 'tts'])) {
    const text = token.rest.trim();
    return { kind: 'command', query: text ? `말 ${text}` : '말' };
  }

  return null;
}

function routeConfirmation(remainder: string): RoutedNaturalLanguageCommand | null {
  const token = firstToken(remainder);
  if (!token) return null;

  if (matchesAny(token.normalized, ['청소', 'clean', 'clear', '내청소', '대청소', 'purge', 'bulk-clear', 'clean-all'])) {
    return buildConfirmation('cleanup', token.rest, '채널 메시지 삭제를 진행할까요?');
  }

  if (matchesAny(token.normalized, ['프리픽스', 'prefix', 'command-prefix'])) {
    return buildConfirmation('prefix-change', token.rest, '서버 프리픽스를 바꿀까요?');
  }

  if (matchesAny(token.normalized, ['기억삭제', 'ai-memory', 'ai-reset-memory', 'memory-reset', 'memory-clear', '메모리삭제', '기억초기화'])) {
    return buildConfirmation('memory-reset', token.rest, '서버 AI 기억을 지울까요?');
  }

  if (matchesAny(token.normalized, ['tts채널', 'tts-channel', 'tts-watch', 'watch', '채널tts'])) {
    return buildConfirmation('watch-channel', token.rest, 'TTS 채널 설정을 바꿀까요?');
  }

  return null;
}

function routeChannelHistory(remainder: string): RoutedNaturalLanguageCommand | null {
  const token = firstToken(remainder);
  if (!token) return null;

  if (!looksLikeChannelReference(token.normalized)) return null;

  const targetChannelReference = token.raw;
  const query = token.rest.trim();
  if (!query) {
    return {
      kind: 'clarify',
      message: '어떤 내용으로 요약하거나 질문할지 같이 적어 주세요...'
    };
  }

  if (containsAny(query.toLowerCase(), ['summary', 'summarize', '요약', '정리', 'describe'])) {
    return { kind: 'channel-history', mode: 'summary', targetChannelReference, query };
  }

  if (containsAny(query.toLowerCase(), ['qa', 'q&a', '질문', '물어봐', '어떤', '무슨', '왜', '어떻게'])) {
    return { kind: 'channel-history', mode: 'qa', targetChannelReference, query };
  }

  if (query.includes('?')) {
    return { kind: 'channel-history', mode: 'qa', targetChannelReference, query };
  }

  return null;
}

function buildConfirmation(intent: ConfirmationIntent, normalizedArgs: string, preview: string): RoutedNaturalLanguageCommand {
  return {
    kind: 'confirmation',
    intent,
    preview,
    query: normalizedArgs.trim(),
    normalizedArgs: normalizedArgs.trim()
  };
}

function firstToken(text: string): { raw: string; normalized: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [raw, ...rest] = trimmed.split(/\s+/);
  return {
    raw,
    normalized: raw.toLowerCase(),
    rest: rest.join(' ')
  };
}

function matchesAny(token: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => token === alias.toLowerCase());
}

function containsAny(token: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => token.includes(alias.toLowerCase()));
}

function looksLikeChannelReference(token: string): boolean {
  return token.startsWith('<#') || token.startsWith('#');
}
