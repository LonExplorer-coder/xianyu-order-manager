import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  OrderIntakeSettingsView,
  SaveOrderIntakeSettingsInput,
} from '../core/order-intake';
import {
  TABLE_TEMPLATE_GRANULARITIES,
  type ActiveTableTemplateIds,
} from '../core/table-templates';

type StoredPreferences = {
  lastDataDirectory?: string;
  lastSourceScreenshotDirectory?: string;
  automaticImportEnabled?: boolean;
  activeTableTemplates?: Record<string, unknown>;
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

  public getOrderIntakeSettings(): OrderIntakeSettingsView {
    return {
      automaticImportEnabled: this.read().automaticImportEnabled === true,
    };
  }

  public saveOrderIntakeSettings(
    input: SaveOrderIntakeSettingsInput,
  ): OrderIntakeSettingsView {
    if (typeof input.automaticImportEnabled !== 'boolean') {
      throw new Error('自动入库设置格式无效');
    }
    this.update({ automaticImportEnabled: input.automaticImportEnabled });
    return { automaticImportEnabled: input.automaticImportEnabled };
  }

  public getAutomaticImportEnabled(): boolean {
    return this.getOrderIntakeSettings().automaticImportEnabled;
  }

  public setAutomaticImportEnabled(automaticImportEnabled: boolean): void {
    this.saveOrderIntakeSettings({ automaticImportEnabled });
  }

  public getActiveTableTemplates(): ActiveTableTemplateIds {
    const stored: unknown = this.read().activeTableTemplates;
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const record = stored as Record<string, unknown>;
    const result: ActiveTableTemplateIds = {};
    for (const granularity of TABLE_TEMPLATE_GRANULARITIES) {
      const value = nonEmptyString(record[granularity]);
      if (value) result[granularity] = value;
    }
    return result;
  }

  public setActiveTableTemplate(
    granularity: unknown,
    templateId: unknown,
  ): ActiveTableTemplateIds {
    if (
      typeof granularity !== 'string'
      || !(TABLE_TEMPLATE_GRANULARITIES as readonly string[]).includes(granularity)
    ) {
      throw new Error('表格模板粒度无效');
    }
    let normalizedId: string | null = null;
    if (templateId !== null) {
      const candidate = nonEmptyString(templateId);
      if (!candidate) throw new Error('表格模板标识无效');
      normalizedId = candidate;
    }
    const current: Record<string, string> = {};
    const stored: unknown = this.read().activeTableTemplates;
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      const record = stored as Record<string, unknown>;
      for (const key of TABLE_TEMPLATE_GRANULARITIES) {
        const value = nonEmptyString(record[key]);
        if (value) current[key] = value;
      }
    }
    if (normalizedId === null) delete current[granularity];
    else current[granularity] = normalizedId;
    this.update({ activeTableTemplates: current });
    return this.getActiveTableTemplates();
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
