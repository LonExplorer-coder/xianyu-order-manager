import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type StoredPreferences = {
  lastDataDirectory?: string;
};

export class Preferences {
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'bootstrap.json');
  }

  public getLastDataDirectory(): string | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredPreferences;
      return typeof parsed.lastDataDirectory === 'string' && parsed.lastDataDirectory.trim()
        ? parsed.lastDataDirectory
        : undefined;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error('无法读取启动配置', { cause: error });
    }
  }

  public setLastDataDirectory(dataDirectory: string): void {
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ lastDataDirectory: dataDirectory }, null, 2)}\n`,
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
