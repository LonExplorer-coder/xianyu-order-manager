import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type StoredPreferences = {
  lastDataDirectory?: string;
  lastSourceScreenshotDirectory?: string;
};

export class Preferences {
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'bootstrap.json');
  }

  public getLastDataDirectory(): string | undefined {
    return nonEmptyString(this.read().lastDataDirectory);
  }

  public setLastDataDirectory(dataDirectory: string): void {
    this.update({ lastDataDirectory: dataDirectory });
  }

  public getLastSourceScreenshotDirectory(): string | undefined {
    return nonEmptyString(this.read().lastSourceScreenshotDirectory);
  }

  public setLastSourceScreenshotDirectory(sourceDirectory: string): void {
    this.update({ lastSourceScreenshotDirectory: sourceDirectory });
  }

  private read(): StoredPreferences {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('启动配置内容格式无效');
      return parsed;
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw new Error('无法读取启动配置', { cause: error });
    }
  }

  private update(changes: StoredPreferences): void {
    const preferences = { ...this.read(), ...changes };
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(preferences, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is StoredPreferences {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
