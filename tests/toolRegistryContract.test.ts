import { describe, expect, it, vi } from 'vitest';
import { createDefaultToolRegistry } from '../src/services/toolRegistry.js';

describe('ToolRegistry observation contract', () => {
  it('returns a structured error for unknown tools', async () => {
    const registry = createDefaultToolRegistry();

    const observation = await registry.execute('missing.tool', {}, { nowMs: 0 });

    expect(observation).toMatchObject({
      callId: '',
      toolName: 'missing.tool',
      status: 'error',
      policy: 'blocked',
      code: 'unknown_tool',
      hint: expect.stringContaining('registered tool')
    });
  });

  it('returns code, field, and hint for schema validation failures', async () => {
    const registry = createDefaultToolRegistry();

    const observation = await registry.execute('web.search', { query: '', count: 99 }, { nowMs: 0 });

    expect(observation).toMatchObject({
      toolName: 'web.search',
      status: 'error',
      policy: 'read_only_auto',
      code: 'validation_error',
      field: 'query',
      message: expect.stringContaining('query must be a non-empty string'),
      hint: expect.stringContaining('query')
    });
  });

  it('returns a structured confirmation observation for confirmation tools', async () => {
    const registry = createDefaultToolRegistry();

    const observation = await registry.execute('settings.prefix', { action: 'set', prefix: '~' }, { nowMs: 0 });

    expect(observation).toMatchObject({
      toolName: 'settings.prefix',
      status: 'confirmation_required',
      policy: 'confirmation_required',
      code: 'confirmation_required',
      confirmation: {
        intent: 'settings.prefix',
        preview: expect.stringContaining('settings.prefix'),
        payload: { action: 'set', prefix: '~' },
        commandQuery: '프리픽스 ~'
      }
    });
  });

  it('returns a structured policy block for blocked tools', async () => {
    const registry = createDefaultToolRegistry();

    const observation = await registry.execute('admin.log_management', {}, { nowMs: 0 });

    expect(observation).toMatchObject({
      toolName: 'admin.log_management',
      status: 'blocked',
      policy: 'blocked',
      code: 'policy_blocked',
      hint: expect.stringContaining('automatic agent loop')
    });
  });

  it('executes voice safe-action tools through structured handlers', async () => {
    const voiceSpeak = vi.fn(async () => ({ message: '음성으로 말했어요...', text: '안녕', autoJoined: true, channelId: 'voice-1' }));
    const voiceStop = vi.fn(async () => ({ message: '재생을 멈췄어요...', stopped: true }));
    const registry = createDefaultToolRegistry({ voiceSpeak, voiceStop });

    const observation = await registry.execute('voice.speak', { text: '안녕' }, { nowMs: 0 });
    const stopObservation = await registry.execute('voice.stop', {}, { nowMs: 0 });

    expect(voiceSpeak).toHaveBeenCalledWith({ text: '안녕' }, { nowMs: 0 });
    expect(voiceStop).toHaveBeenCalledWith({}, { nowMs: 0 });
    expect(observation).toMatchObject({
      toolName: 'voice.speak',
      status: 'ok',
      policy: 'safe_action_auto',
      output: expect.objectContaining({ message: '음성으로 말했어요...', text: '안녕', autoJoined: true })
    });
    expect(stopObservation).toMatchObject({
      toolName: 'voice.stop',
      status: 'ok',
      policy: 'safe_action_auto',
      output: expect.objectContaining({ message: '재생을 멈췄어요...', stopped: true })
    });
  });

  it('executes requester TTS and time-zone setting tools through structured handlers', async () => {
    const ttsVoicePreset = vi.fn(async () => ({ message: '내 TTS 음색을 sunhi로 저장했어요...', current: 'sunhi', available: ['sunhi'] }));
    const ttsEngine = vi.fn(async () => ({ message: '내 TTS 엔진을 edge로 저장했어요...', current: 'edge', available: ['edge', 'gtts'] }));
    const userTimezone = vi.fn(async () => ({ message: '내 시간대를 Asia/Seoul로 저장했어요...', current: 'Asia/Seoul', defaultTimeZone: 'Asia/Seoul' }));
    const registry = createDefaultToolRegistry({ ttsVoicePreset, ttsEngine, userTimezone });

    const preset = await registry.execute('tts.voice_preset', { action: 'set', preset: 'sunhi' }, { nowMs: 0 });
    const engine = await registry.execute('tts.engine', { action: 'set', engine: 'edge' }, { nowMs: 0 });
    const timezone = await registry.execute('time.user_timezone', { action: 'set', timeZone: 'Asia/Seoul' }, { nowMs: 0 });
    const badTimezone = await registry.execute('time.user_timezone', { action: 'set', timeZone: 'not-a-zone' }, { nowMs: 0 });

    expect(preset).toMatchObject({ toolName: 'tts.voice_preset', status: 'ok', policy: 'safe_action_auto' });
    expect(engine).toMatchObject({ toolName: 'tts.engine', status: 'ok', policy: 'safe_action_auto' });
    expect(timezone).toMatchObject({ toolName: 'time.user_timezone', status: 'ok', policy: 'safe_action_auto' });
    expect(badTimezone).toMatchObject({ toolName: 'time.user_timezone', status: 'error', code: 'validation_error', field: 'timeZone' });
  });

  it('validates settings, AI-channel, web-search, and memory confirmation tools', async () => {
    const registry = createDefaultToolRegistry();

    const ttsMissing = await registry.execute('settings.tts_channel', { action: 'set' }, { nowMs: 0 });
    const aiChannel = await registry.execute('settings.ai_channel', { action: 'set', channelRef: '#ai' }, { nowMs: 0 });
    const webSearch = await registry.execute('settings.web_search', { mode: 'automatic' }, { nowMs: 0 });
    const webSearchDefault = await registry.execute('settings.web_search', { mode: 'default' }, { nowMs: 0 });
    const memory = await registry.execute('memory.delete', { scope: 'guild' }, { nowMs: 0 });

    expect(ttsMissing).toMatchObject({
      toolName: 'settings.tts_channel',
      status: 'error',
      code: 'validation_error',
      field: 'channelRef'
    });
    expect(aiChannel).toMatchObject({
      toolName: 'settings.ai_channel',
      status: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: 'ai채널 #ai' })
    });
    expect(webSearch).toMatchObject({
      toolName: 'settings.web_search',
      status: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: '웹검색 automatic' })
    });
    expect(webSearchDefault).toMatchObject({
      toolName: 'settings.web_search',
      status: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: '웹검색 초기화' })
    });
    expect(memory).toMatchObject({
      toolName: 'memory.delete',
      status: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: '기억삭제' })
    });
  });

  it('validates cleanup tools with structured count, target, and evidence before confirmation', async () => {
    const registry = createDefaultToolRegistry();

    const invalid = await registry.execute('command.cleanup', { target: 'self', count: 0 }, { nowMs: 0 });
    const booleanCount = await registry.execute('command.cleanup', { target: 'self', count: true, evidence: '내 채팅' }, { nowMs: 0 });
    const stringCount = await registry.execute('command.mass_cleanup', { target: 'channel', count: '5' }, { nowMs: 0 });
    const valid = await registry.execute('command.cleanup', { target: 'self', count: 3, evidence: '내 채팅' }, { nowMs: 0 });
    const mass = await registry.execute('command.mass_cleanup', { target: 'channel', count: 5 }, { nowMs: 0 });

    expect(invalid).toMatchObject({
      toolName: 'command.cleanup',
      status: 'error',
      policy: 'confirmation_required',
      code: 'validation_error',
      field: 'count'
    });
    expect(booleanCount).toMatchObject({ toolName: 'command.cleanup', status: 'error', code: 'validation_error', field: 'count' });
    expect(stringCount).toMatchObject({ toolName: 'command.mass_cleanup', status: 'error', code: 'validation_error', field: 'count' });
    expect(valid).toMatchObject({
      toolName: 'command.cleanup',
      status: 'confirmation_required',
      policy: 'confirmation_required',
      code: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: '청소 3', payload: { target: 'self', count: 3, evidence: '내 채팅' } })
    });
    expect(mass).toMatchObject({
      toolName: 'command.mass_cleanup',
      status: 'confirmation_required',
      confirmation: expect.objectContaining({ commandQuery: '대청소 5', payload: { target: 'channel', count: 5 } })
    });
  });

  it('keeps cleanup evidence and voice-location rules in tool contracts', () => {
    const registry = createDefaultToolRegistry();
    const cleanup = registry.get('command.cleanup');
    const massCleanup = registry.get('command.mass_cleanup');
    const runtimeContext = registry.get('runtime.context');

    expect(cleanup?.description).toContain('AI-owned internal safety quote');
    expect(cleanup?.description).toContain('never a user-facing clarification slot');
    expect(cleanup?.inputSchema).toContain('literal quote from current/stored user text');
    expect(cleanup?.inputSchema).toContain('never ask user for evidence');
    expect(massCleanup?.description).toContain('channel-wide cleanup');
    expect(massCleanup?.inputSchema).toContain('no evidence field');
    expect(runtimeContext?.description).toContain('userVoiceChannel is requester-only');
    expect(runtimeContext?.description).toContain('botVoiceConnected/botVoiceChannel');
  });

  it('rejects coerced integer fields for read-only tools', async () => {
    const registry = createDefaultToolRegistry();

    const timeOffset = await registry.execute('time.viewer', { offsetSeconds: '60' }, { nowMs: 0 });
    const historyLimit = await registry.execute('history.search', { scope: 'server', query: '', mode: 'summary', limit: '5' }, { nowMs: 0 });
    const webCount = await registry.execute('web.search', { query: 'SearXNG', count: true }, { nowMs: 0 });

    expect(timeOffset).toMatchObject({ toolName: 'time.viewer', status: 'error', code: 'validation_error', field: 'offsetSeconds' });
    expect(historyLimit).toMatchObject({ toolName: 'history.search', status: 'error', code: 'validation_error', field: 'limit' });
    expect(webCount).toMatchObject({ toolName: 'web.search', status: 'error', code: 'validation_error', field: 'count' });
  });

  it('preserves successful read-only output and unavailable errors in the same observation shape', async () => {
    const registry = createDefaultToolRegistry({
      webSearch: vi.fn(async () => {
        throw new Error('search offline');
      })
    });

    const ok = await registry.execute('time.in_zone', { timeZone: 'Asia/Seoul', label: '서울' }, { nowMs: Date.parse('2026-05-22T18:15:00.000Z') });
    const error = await registry.execute('web.search', { query: 'SearXNG', count: 1 }, { nowMs: 0 });

    expect(ok).toMatchObject({
      toolName: 'time.in_zone',
      status: 'ok',
      policy: 'read_only_auto',
      output: expect.objectContaining({ timeZone: 'Asia/Seoul', label: '서울' })
    });
    expect(error).toMatchObject({
      toolName: 'web.search',
      status: 'error',
      policy: 'read_only_auto',
      code: 'tool_unavailable',
      message: 'search offline',
      hint: expect.stringContaining('unavailable')
    });
  });
});
