import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';

export type TtsEngine = 'edge' | 'gtts';

export function normalizeTtsEngineName(value: string): TtsEngine | undefined {
  const normalized = value.trim().toLowerCase();
  if (['edge', '엣지'].includes(normalized)) return 'edge';
  if (['gtts', 'google', '구글'].includes(normalized)) return 'gtts';
  return undefined;
}

const execFileAsync = promisify(execFile);
const pythonBinary = process.env.PYTHON_BIN ?? 'python3';

const packageImportByEngine: Record<TtsEngine, string> = {
  edge: 'edge_tts',
  gtts: 'gtts'
};

const pipPackageByEngine: Record<TtsEngine, string> = {
  edge: 'edge-tts',
  gtts: 'gTTS'
};

let installPromiseByPackage = new Map<string, Promise<void>>();

async function ensurePythonPackage(engine: TtsEngine): Promise<void> {
  const importName = packageImportByEngine[engine];
  try {
    await execFileAsync(pythonBinary, ['-c', `import ${importName}`]);
  } catch {
    const packageName = pipPackageByEngine[engine];
    let installPromise = installPromiseByPackage.get(packageName);
    if (!installPromise) {
      installPromise = execFileAsync(pythonBinary, ['-m', 'pip', 'install', '--user', packageName]).then(() => undefined);
      installPromiseByPackage.set(packageName, installPromise);
    }
    await installPromise;
    await execFileAsync(pythonBinary, ['-c', `import ${importName}`]);
  }
}

export class TtsService {
  constructor(
    private readonly voice: string,
    private readonly maxChars: number
  ) {}

  sanitize(text: string): string {
    return text
      .replace(/https?:\/\/\S+/g, '링크')
      .replace(/<a?:\w+:\d+>/g, '이모지')
      .replace(/<@!?\d+>/g, '멘션')
      .replace(/<#\d+>/g, '채널')
      .trim()
      .slice(0, this.maxChars);
  }

  async synthesize(text: string, voice = this.voice, engine: TtsEngine = 'edge'): Promise<string> {
    const sanitized = this.sanitize(text);
    if (!sanitized) throw new Error('TTS로 읽을 텍스트가 없어요.');

    const dir = join(tmpdir(), 'chococobot-tts');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${nanoid()}.mp3`);

    await ensurePythonPackage(engine);

    if (engine === 'edge') {
      await execFileAsync(pythonBinary, [
        '-m',
        'edge_tts',
        '--text',
        sanitized,
        '--voice',
        voice,
        '--write-media',
        filePath
      ]);
      return filePath;
    }

    const script = [
      'import sys',
      'from gtts import gTTS',
      'text = sys.argv[1]',
      'file_path = sys.argv[2]',
      "gTTS(text=text, lang='ko').save(file_path)"
    ].join('; ');

    await execFileAsync(pythonBinary, ['-c', script, sanitized, filePath]);
    return filePath;
  }

  async cleanup(filePath: string): Promise<void> {
    await rm(filePath, { force: true });
  }
}
