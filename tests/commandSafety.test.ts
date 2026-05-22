import { describe, expect, it } from 'vitest';
import { classifyCommandQuery } from '../src/services/commandSafety.js';

describe('classifyCommandQuery', () => {
  it('classifies planner command families deterministically', () => {
    expect(classifyCommandQuery('도움말').level).toBe('safe');
    expect(classifyCommandQuery('들어와').level).toBe('voice-precondition');
    expect(classifyCommandQuery('나가').level).toBe('safe');
    expect(classifyCommandQuery('멈춰').level).toBe('safe');
    expect(classifyCommandQuery('말 안녕').level).toBe('voice-precondition');
    expect(classifyCommandQuery('음색 sunhi').level).toBe('safe');
    expect(classifyCommandQuery('tts엔진 edge').level).toBe('safe');
    expect(classifyCommandQuery('프리픽스').level).toBe('safe');
    expect(classifyCommandQuery('프리픽스 ~')).toMatchObject({ level: 'needs-confirmation', intent: 'prefix-change' });
    expect(classifyCommandQuery('기억삭제')).toMatchObject({ level: 'destructive', intent: 'memory-reset' });
    expect(classifyCommandQuery('tts채널 #general')).toMatchObject({ level: 'needs-confirmation', intent: 'watch-channel' });
    expect(classifyCommandQuery('청소 10')).toMatchObject({ level: 'needs-confirmation', intent: 'cleanup' });
    expect(classifyCommandQuery('대청소 10')).toMatchObject({ level: 'destructive', intent: 'cleanup' });
    expect(classifyCommandQuery('없는명령')).toMatchObject({ level: 'unknown' });
  });
});
