import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_OCR_ESTIMATED_PRICE_PER_CALL_CENTS,
  DEFAULT_OCR_MONTHLY_LIMIT_CENTS,
  type OcrQuotaMode,
  type OcrUsageQuotaSettings,
} from '../core/ocr-usage';

export interface OcrUsageSettingsRepository {
  read(): OcrUsageQuotaSettings;
  write(settings: OcrUsageQuotaSettings): void;
}

const DEFAULT_SETTINGS: OcrUsageQuotaSettings = {
  monthlyLimitCents: DEFAULT_OCR_MONTHLY_LIMIT_CENTS,
  mode: 'remind',
  estimatedPricePerCallCents: DEFAULT_OCR_ESTIMATED_PRICE_PER_CALL_CENTS,
  pausedMonth: null,
  resumedMonth: null,
};

export class OcrUsageSettingsFile implements OcrUsageSettingsRepository {
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'ocr-usage-settings.json');
  }

  public read(): OcrUsageQuotaSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (
        !isNonNegativeInteger(parsed.monthlyLimitCents) ||
        !isQuotaMode(parsed.mode) ||
        !isNonNegativeInteger(parsed.estimatedPricePerCallCents) ||
        (parsed.pausedMonth !== null && typeof parsed.pausedMonth !== 'string') ||
        (parsed.resumedMonth !== null && typeof parsed.resumedMonth !== 'string')
      ) {
        throw new Error('invalid OCR usage settings');
      }
      return {
        monthlyLimitCents: parsed.monthlyLimitCents,
        mode: parsed.mode,
        estimatedPricePerCallCents: parsed.estimatedPricePerCallCents,
        pausedMonth: parsed.pausedMonth,
        resumedMonth: parsed.resumedMonth,
      };
    } catch (error) {
      if (isMissingFile(error)) return { ...DEFAULT_SETTINGS };
      throw new Error('无法读取 OCR 用量设置', { cause: error });
    }
  }

  public write(settings: OcrUsageQuotaSettings): void {
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isQuotaMode(value: unknown): value is OcrQuotaMode {
  return value === 'remind' || value === 'hard_stop';
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
