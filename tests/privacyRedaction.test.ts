import { afterEach, describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/services/privacyRedaction.js';

const ORIGINAL_SECRET = process.env.TEST_API_KEY;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TEST_API_KEY;
  else process.env.TEST_API_KEY = ORIGINAL_SECRET;
});

describe('redactSecrets', () => {
  it('redacts configured secret environment values without redacting ordinary email or numbers', () => {
    process.env.TEST_API_KEY = 'env-secret-value-1234567890';

    const result = redactSecrets('email a@example.com number 010-1234-5678 key env-secret-value-1234567890');

    expect(result.text).toContain('a@example.com');
    expect(result.text).toContain('010-1234-5678');
    expect(result.text).not.toContain('env-secret-value-1234567890');
    expect(result.text).toContain('[redacted-secret]');
    expect(result.redactions).toContain('env-secret');
  });

  it('redacts common API key and authorization token forms', () => {
    const result = redactSecrets([
      'Authorization: Bot abcdefghijklmnopqrstuvwxyz.abcdef.abcdefghijklmnopqrstuvwxyz123456',
      'groq=gsk_abcdefghijklmnopqrstuvwxyz123456',
      'openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'password=super-secret-value'
    ].join('\n'));

    expect(result.text).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.text).toContain('Authorization: Bot [redacted-secret]');
    expect(result.redactions.length).toBeGreaterThan(0);
  });
});
