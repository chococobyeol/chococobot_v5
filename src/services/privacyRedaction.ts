export type RedactionResult = {
  text: string;
  redactions: string[];
};

const SECRET_ENV_NAME_PATTERN = /(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)/iu;
const MIN_ENV_SECRET_LENGTH = 12;

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp; replacement?: string }> = [
  {
    label: 'authorization-header',
    pattern: /\b(Authorization\s*[:=]\s*(?:Bot|Bearer)\s+)[^\s"'`,]+/giu,
    replacement: '$1[redacted-secret]'
  },
  { label: 'discord-token', pattern: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/gu },
  { label: 'groq-api-key', pattern: /\bgsk_[A-Za-z0-9_-]{20,}\b/gu },
  { label: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu },
  { label: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/gu },
  { label: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu },
  {
    label: 'secret-assignment',
    pattern: /\b((?:token|api[_-]?key|secret|password)\s*[:=]\s*)[^\s"'`,]+/giu,
    replacement: '$1[redacted-secret]'
  }
];

function addRedaction(redactions: Set<string>, label: string): void {
  redactions.add(label);
}

function envSecrets(): string[] {
  const values = Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME_PATTERN.test(name) && typeof value === 'string' && value.length >= MIN_ENV_SECRET_LENGTH)
    .map(([, value]) => value as string)
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  return values;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const redactions = new Set<string>();

  for (const secret of envSecrets()) {
    if (!text.includes(secret)) continue;
    text = text.split(secret).join('[redacted-secret]');
    addRedaction(redactions, 'env-secret');
  }

  for (const { label, pattern, replacement } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement ?? '[redacted-secret]');
    addRedaction(redactions, label);
  }

  return { text, redactions: [...redactions] };
}

export function formatRedactionMetadata(redactions: readonly string[]): string {
  return redactions.length ? ` redactions=${redactions.join(',')}` : '';
}
