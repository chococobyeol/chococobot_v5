import { generateDependencyReport } from '@discordjs/voice';

export type VoiceDiagnostic = {
  ok: boolean;
  report: string;
  problems: string[];
};

export async function diagnoseVoiceStack(): Promise<VoiceDiagnostic> {
  const report = generateDependencyReport();
  const problems: string[] = [];

  try {
    await import('@snazzah/davey');
  } catch {
    problems.push('@snazzah/davey is missing; DAVE/E2EE voice calls may fail with close code 4017.');
  }

  if (!report.includes('@discordjs/voice')) {
    problems.push('@discordjs/voice dependency report did not include voice package metadata.');
  }

  return { ok: problems.length === 0, report, problems };
}

export function isDaveCloseCode(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return text.includes('4017') || /DAVE|E2EE/i.test(text);
}
