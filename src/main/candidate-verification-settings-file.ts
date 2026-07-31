import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  normalizeCandidateVerificationBaseUrl,
  normalizeCandidateVerificationModel,
  type CandidateVerificationProvider,
} from '../core/candidate-verification-settings';
import type {
  CandidateVerificationSettingsRecord,
  CandidateVerificationSettingsRepository,
} from './candidate-verification-settings';

const PROVIDERS = new Set<CandidateVerificationProvider>([
  'deepseek',
  'aliyun-bailian',
  'openai-compatible',
]);

export class CandidateVerificationSettingsFile
  implements CandidateVerificationSettingsRepository
{
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'candidate-verification-settings.json');
  }

  public read(): CandidateVerificationSettingsRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        typeof parsed.enabled !== 'boolean' ||
        typeof parsed.provider !== 'string' ||
        !PROVIDERS.has(parsed.provider as CandidateVerificationProvider) ||
        typeof parsed.baseUrl !== 'string' ||
        typeof parsed.model !== 'string' ||
        (
          parsed.credentialTargetConfirmed !== undefined &&
          typeof parsed.credentialTargetConfirmed !== 'boolean'
        )
      ) {
        throw new Error('invalid candidate verification settings');
      }
      const provider = parsed.provider as CandidateVerificationProvider;
      const baseUrl = normalizeCandidateVerificationBaseUrl(provider, parsed.baseUrl);
      return {
        enabled: parsed.enabled,
        provider,
        baseUrl,
        model: normalizeCandidateVerificationModel(parsed.model),
        credentialTargetConfirmed: parsed.credentialTargetConfirmed === undefined
          ? provider === 'deepseek'
          : parsed.credentialTargetConfirmed,
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error('无法读取候选裁决设置', { cause: error });
    }
  }

  public write(record: CandidateVerificationSettingsRecord): void {
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          enabled: record.enabled,
          provider: record.provider,
          baseUrl: record.baseUrl,
          model: record.model,
          credentialTargetConfirmed: record.credentialTargetConfirmed,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
