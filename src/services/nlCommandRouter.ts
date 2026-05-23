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
    return buildConfirmation('cleanup', token.raw, token.rest, '채널 메시지 삭제를 진행할까요?');
  }

  if (matchesAny(token.normalized, ['프리픽스', 'prefix', 'command-prefix'])) {
    return buildConfirmation('prefix-change', token.raw, token.rest, '서버 프리픽스를 바꿀까요?');
  }

  if (matchesAny(token.normalized, ['기억삭제', 'ai-memory', 'ai-reset-memory', 'memory-reset', 'memory-clear', '메모리삭제', '기억초기화'])) {
    return buildConfirmation('memory-reset', token.raw, token.rest, '서버 AI 기억을 지울까요?');
  }

  if (matchesAny(token.normalized, ['tts채널', 'tts-channel', 'tts-watch', 'watch', '채널tts'])) {
    return buildConfirmation('watch-channel', token.raw, token.rest, 'TTS 채널 설정을 바꿀까요?');
  }

  if (matchesAny(token.normalized, ['ai채널', 'ai-channel', 'ai-chat-channel', 'ai-watch', '채널ai'])) {
    return buildConfirmation('ai-channel', token.raw, token.rest, 'AI 채팅 채널 설정을 바꿀까요?');
  }

  return null;
}

function buildConfirmation(intent: ConfirmationIntent, commandName: string, normalizedArgs: string, preview: string): RoutedNaturalLanguageCommand {
  const trimmedArgs = normalizedArgs.trim();
  return {
    kind: 'confirmation',
    intent,
    preview,
    query: [commandName, trimmedArgs].filter(Boolean).join(' '),
    normalizedArgs: trimmedArgs
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
