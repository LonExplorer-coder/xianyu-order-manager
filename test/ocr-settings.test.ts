import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { OcrSettingsFile } from '../src/main/ocr-settings-file';
import {
  OcrSettingsService,
  type ApiKeyStore,
  type BailianConnectionTester,
  type OcrSettingsRecord,
  type OcrSettingsRepository,
} from '../src/main/ocr-settings';

const immediatePaidOperation = {
  runPaidOperation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
};

class MemorySettingsRepository implements OcrSettingsRepository {
  public constructor(public record: OcrSettingsRecord | null = null) {}

  public read(): OcrSettingsRecord | null {
    return this.record;
  }

  public write(record: OcrSettingsRecord): void {
    this.record = structuredClone(record);
  }
}

class MemoryApiKeyStore implements ApiKeyStore {
  public constructor(public apiKey: string | null = null) {}

  public async getApiKey(): Promise<string | null> {
    return this.apiKey;
  }

  public async setApiKey(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
  }

  public async deleteApiKey(): Promise<void> {
    this.apiKey = null;
  }

  public getDisplayName(): string {
    return '测试系统凭据库';
  }
}

const unusedTester: BailianConnectionTester = {
  testConnection: async () => ({ model: 'qwen3.5-ocr' }),
};

describe('OCR 设置', () => {
  it('只向界面返回掩码状态，不返回系统凭据库中的 API Key', async () => {
    const sentinelApiKey = 'sk-secret-sentinel-never-render';
    const service = new OcrSettingsService(
      new MemorySettingsRepository({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
      }),
      new MemoryApiKeyStore(sentinelApiKey),
      unusedTester,
    );

    const view = await service.getSettings();

    expect(view).toEqual({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: '测试系统凭据库',
    });
    expect(JSON.stringify(view)).not.toContain(sentinelApiKey);
  });

  it('把 API Key 只写入系统凭据库，并把非敏感配置单独保存', async () => {
    const sentinelApiKey = 'sk-secret-sentinel-storage';
    const repository = new MemorySettingsRepository();
    const apiKeyStore = new MemoryApiKeyStore();
    const service = new OcrSettingsService(repository, apiKeyStore, unusedTester);

    const view = await service.saveSettings({
      workspaceId: '  ws-test456  ',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
    });

    expect(repository.record).toEqual({
      workspaceId: 'ws-test456',
      region: 'cn-beijing',
    });
    expect(JSON.stringify(repository.record)).not.toContain(sentinelApiKey);
    expect(apiKeyStore.apiKey).toBe(sentinelApiKey);
    expect(view).toMatchObject({
      workspaceId: 'ws-test456',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
    });
    expect(JSON.stringify(view)).not.toContain(sentinelApiKey);
  });

  it('未填写新 API Key 时保留当前系统凭据', async () => {
    const sentinelApiKey = 'sk-existing-secret-sentinel';
    const repository = new MemorySettingsRepository({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
    });
    const apiKeyStore = new MemoryApiKeyStore(sentinelApiKey);
    const service = new OcrSettingsService(repository, apiKeyStore, unusedTester);

    await service.saveSettings({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
      apiKey: '',
    });

    expect(apiKeyStore.apiKey).toBe(sentinelApiKey);
    expect(repository.record).toEqual({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
    });
  });

  it('更换 Workspace ID 时要求重新填写与新空间匹配的 API Key', async () => {
    const repository = new MemorySettingsRepository({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
    });
    const apiKeyStore = new MemoryApiKeyStore('sk-existing-secret');
    const service = new OcrSettingsService(repository, apiKeyStore, unusedTester);

    await expect(
      service.saveSettings({
        workspaceId: 'ws-another',
        region: 'cn-beijing',
        apiKey: '',
      }),
    ).rejects.toThrow('更换 Workspace ID 或地域时，请重新填写 API Key');
    expect(repository.record?.workspaceId).toBe('ws-existing');
  });

  it('保存前拒绝可能改变百炼目标主机的 Workspace ID', async () => {
    const repository = new MemorySettingsRepository();
    const apiKeyStore = new MemoryApiKeyStore();
    const service = new OcrSettingsService(repository, apiKeyStore, unusedTester);

    await expect(
      service.saveSettings({
        workspaceId: 'evil.example.com/path',
        region: 'cn-beijing',
        apiKey: 'sk-never-persist-invalid-workspace',
      }),
    ).rejects.toThrow('Workspace ID 格式无效');

    expect(repository.record).toBeNull();
    expect(apiKeyStore.apiKey).toBeNull();
  });

  it('非敏感配置写入失败时恢复原有系统凭据', async () => {
    const oldApiKey = 'sk-existing-before-failed-write';
    const apiKeyStore = new MemoryApiKeyStore(oldApiKey);
    const repository: OcrSettingsRepository = {
      read: () => ({ workspaceId: 'ws-existing', region: 'cn-beijing' }),
      write: () => {
        throw new Error('disk failure with private path');
      },
    };
    const service = new OcrSettingsService(repository, apiKeyStore, unusedTester);

    await expect(
      service.saveSettings({
        workspaceId: 'ws-existing',
        region: 'cn-beijing',
        apiKey: 'sk-new-secret-must-be-rolled-back',
      }),
    ).rejects.toThrow('无法保存 OCR 设置，请重试');

    expect(apiKeyStore.apiKey).toBe(oldApiKey);
  });

  it('可从系统凭据库移除 API Key，界面随后只显示未配置状态', async () => {
    const apiKeyStore = new MemoryApiKeyStore('sk-secret-to-remove');
    const service = new OcrSettingsService(
      new MemorySettingsRepository({
        workspaceId: 'ws-existing',
        region: 'cn-beijing',
      }),
      apiKeyStore,
      unusedTester,
    );

    const view = await service.removeApiKey();

    expect(apiKeyStore.apiKey).toBeNull();
    expect(view).toMatchObject({
      workspaceId: 'ws-existing',
      apiKeyConfigured: false,
      apiKeyMask: '',
    });
  });

  it('重启后恢复非敏感配置，配置文件中不出现 API Key', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'xianyu-ocr-settings-'));
    const sentinelApiKey = 'sk-secret-never-in-config-file';
    const apiKeyStore = new MemoryApiKeyStore();
    const service = new OcrSettingsService(
      new OcrSettingsFile(configDirectory),
      apiKeyStore,
      unusedTester,
    );

    await service.saveSettings({
      workspaceId: 'ws-restart',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
    });

    const persisted = await readFile(join(configDirectory, 'ocr-settings.json'), 'utf8');
    expect(persisted).toContain('ws-restart');
    expect(persisted).not.toContain(sentinelApiKey);

    const reopened = new OcrSettingsService(
      new OcrSettingsFile(configDirectory),
      apiKeyStore,
      unusedTester,
    );
    await expect(reopened.getSettings()).resolves.toMatchObject({
      workspaceId: 'ws-restart',
      apiKeyConfigured: true,
    });
  });

  it('只有用户明确确认可能产生费用后才发起连接测试', async () => {
    const sentinelApiKey = 'sk-explicit-paid-test';
    const testConnection = vi.fn(async () => ({ model: 'qwen3.5-ocr' as const }));
    const service = new OcrSettingsService(
      new MemorySettingsRepository({
        workspaceId: 'ws-explicit',
        region: 'cn-beijing',
      }),
      new MemoryApiKeyStore(sentinelApiKey),
      { testConnection },
    );

    await expect(
      service.testConnection({ consentToPaidCall: false }, immediatePaidOperation),
    ).rejects.toThrow('请先确认本次测试会产生一次 OCR 调用');
    expect(testConnection).not.toHaveBeenCalled();

    const result = await service.testConnection(
      { consentToPaidCall: true },
      immediatePaidOperation,
    );

    expect(testConnection).toHaveBeenCalledWith({
      workspaceId: 'ws-explicit',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
    });
    expect(result).toEqual({
      ok: true,
      model: 'qwen3.5-ocr',
      message: '连接成功，qwen3.5-ocr 可以使用',
    });
    expect(JSON.stringify(result)).not.toContain(sentinelApiKey);
  });
});
