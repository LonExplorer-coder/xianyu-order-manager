import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OcrSettingsRecord, OcrSettingsRepository } from './ocr-settings';

export class OcrSettingsFile implements OcrSettingsRepository {
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'ocr-settings.json');
  }

  public read(): OcrSettingsRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (
        typeof parsed.workspaceId !== 'string' ||
        !parsed.workspaceId.trim() ||
        parsed.region !== 'cn-beijing'
      ) {
        throw new Error('invalid OCR settings');
      }
      return {
        workspaceId: parsed.workspaceId,
        region: parsed.region,
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error('无法读取 OCR 设置', { cause: error });
    }
  }

  public write(record: OcrSettingsRecord): void {
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          workspaceId: record.workspaceId,
          region: record.region,
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
