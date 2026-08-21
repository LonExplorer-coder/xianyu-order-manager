import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CandidateVerificationSettingsFile } from '../src/main/candidate-verification-settings-file';
import {
  CandidateVerificationSettingsService,
  type CandidateVerificationApiKeyStore,
  type CandidateVerificationConnectionTester,
  type CandidateVerificationSettingsRecord,
  type CandidateVerificationSettingsRepository,
} from '../src/main/candidate-verification-settings';

const immediatePaidOperation = {
  runPaidOperation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
};

class MemorySettingsRepository implements CandidateVerificationSettingsRepository {
  public constructor(public record: CandidateVerificationSettingsRecord | null = null) {}

  public read(): CandidateVerificationSettingsRecord | null {
    return this.record;
  }

  public write(record: CandidateVerificationSettingsRecord): void {
    this.record = structuredClone(record);
  }
}

class MemoryApiKeyStore implements CandidateVerificationApiKeyStore {
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

class GatedSetApiKeyStore extends MemoryApiKeyStore {
  private readonly setStartedPromise: Promise<void>;
  private resolveSetStarted!: () => void;
  private readonly continueSetPromise: Promise<void>;
  private resolveContinueSet!: () => void;

  public constructor(apiKey: string | null) {
    super(apiKey);
    this.setStartedPromise = new Promise((resolve) => {
      this.resolveSetStarted = resolve;
    });
    this.continueSetPromise = new Promise((resolve) => {
      this.resolveContinueSet = resolve;
    });
  }

  public override async setApiKey(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    this.resolveSetStarted();
    await this.continueSetPromise;
  }

  public waitUntilSetStarted(): Promise<void> {
    return this.setStartedPromise;
  }

  public continueSet(): void {
    this.resolveContinueSet();
  }
}

function keyStores() {
  return {
    deepseek: new MemoryApiKeyStore(),
    'aliyun-bailian': new MemoryApiKeyStore(),
    'openai-compatible': new MemoryApiKeyStore(),
  };
}

const unusedTester: CandidateVerificationConnectionTester = {
  testConnection: async (input) => ({ model: input.model }),
};

describe('候选裁决设置', () => {
  it('旧版本没有独立配置时默认关闭并选中 DeepSeek 预设', async () => {
    const service = new CandidateVerificationSettingsService(
      new MemorySettingsRepository(),
      keyStores(),
      unusedTester,
    );

    await expect(service.getSettings()).resolves.toEqual({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      baseUrlLocked: true,
      model: 'deepseek-v4-flash',
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    });
  });

  it('保存 DeepSeek 预设时把 API Key 只写入 DeepSeek 独立凭据', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );
    const sentinelApiKey = 'sk-deepseek-never-persist';

    const view = await service.saveSettings({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: '  deepseek-v4-flash  ',
      apiKey: `  ${sentinelApiKey}  `,
    });

    expect(repository.record).toEqual({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      credentialTargetConfirmed: true,
    });
    expect(JSON.stringify(repository.record)).not.toContain(sentinelApiKey);
    expect(stores.deepseek.apiKey).toBe(sentinelApiKey);
    expect(stores['aliyun-bailian'].apiKey).toBeNull();
    expect(stores['openai-compatible'].apiKey).toBeNull();
    expect(view).toMatchObject({ enabled: true, apiKeyConfigured: true });
    expect(JSON.stringify(view)).not.toContain(sentinelApiKey);
  });

  it('DeepSeek 预设拒绝改写固定 Base URL', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(
      service.saveSettings({
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://credential-leak.example.com',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-must-not-leak',
      }),
    ).rejects.toThrow('DeepSeek Base URL 固定为 https://api.deepseek.com');

    expect(repository.record).toBeNull();
    expect(stores.deepseek.apiKey).toBeNull();
  });

  it('设置服务本身也拒绝含控制字符的模型名和密钥', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(service.saveSettings({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek\nmalicious',
      apiKey: '',
    })).rejects.toThrow('验证模型名称格式无效');
    await expect(service.saveSettings({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-safe\rInjected: true',
    })).rejects.toThrow('验证模型 API Key 格式无效');
    expect(repository.record).toBeNull();
    expect(stores.deepseek.apiKey).toBeNull();
  });

  it('自定义兼容服务拒绝把 API Key 发往非回环 HTTP 地址', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(
      service.saveSettings({
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://models.example.com/v1',
        model: 'example-model',
        apiKey: 'sk-must-not-cross-plain-http',
      }),
    ).rejects.toThrow('非本机 Base URL 必须使用 HTTPS');

    expect(repository.record).toBeNull();
    expect(stores['openai-compatible'].apiKey).toBeNull();
  });

  it('用户粘贴完整 Chat Completions 地址时规范为 Base URL', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1/chat/completions',
      model: 'example-model',
      apiKey: 'sk-compatible',
    });

    expect(repository.record?.baseUrl).toBe('https://models.example.com/v1');
  });

  it.each([
    'https://user:password@models.example.com/v1',
    'https://models.example.com/v1?target=other',
    'https://models.example.com/v1#fragment',
  ])('拒绝带凭据、查询或片段的 Base URL：%s', async (baseUrl) => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl,
      model: 'example-model',
      apiKey: 'sk-must-not-leak',
    })).rejects.toThrow('Base URL 不能包含用户名、密码、查询参数或片段');

    expect(repository.record).toBeNull();
    expect(stores['openai-compatible'].apiKey).toBeNull();
  });

  it('切换服务商时不把当前服务商的 API Key 串用给新服务商', async () => {
    const repository = new MemorySettingsRepository({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      credentialTargetConfirmed: true,
    });
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-deepseek-only';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(
      service.saveSettings({
        enabled: true,
        provider: 'aliyun-bailian',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        apiKey: '',
      }),
    ).rejects.toThrow('更换服务商或 Base URL 时，请重新填写验证模型 API Key');

    expect(repository.record?.provider).toBe('deepseek');
    expect(stores.deepseek.apiKey).toBe('sk-deepseek-only');
    expect(stores['aliyun-bailian'].apiKey).toBeNull();
  });

  it('关闭状态下可先切换服务商且不会串用或要求 API Key', async () => {
    const repository = new MemorySettingsRepository({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      credentialTargetConfirmed: true,
    });
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-deepseek-only';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await service.saveSettings({
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'example-model',
      apiKey: '',
    });

    expect(repository.record).toEqual({
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'example-model',
      credentialTargetConfirmed: false,
    });
    expect(stores.deepseek.apiKey).toBe('sk-deepseek-only');
    expect(stores['openai-compatible'].apiKey).toBeNull();
  });

  it('配置记录缺失时不把遗留的自定义密钥发往新端点', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    stores['openai-compatible'].apiKey = 'sk-orphaned-compatible-key';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://new-endpoint.example.com/v1',
      model: 'new-model',
      apiKey: '',
    })).rejects.toThrow('请填写验证模型 API Key');

    expect(repository.record).toBeNull();
    expect(stores['openai-compatible'].apiKey).toBe('sk-orphaned-compatible-key');
  });

  it('关闭状态切换到新端点后不把遗留密钥标记为已绑定', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    stores['openai-compatible'].apiKey = 'sk-orphaned-compatible-key';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(service.saveSettings({
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: 'https://new-endpoint.example.com/v1',
      model: 'new-model',
      apiKey: '',
    })).resolves.toMatchObject({
      enabled: false,
      apiKeyConfigured: false,
    });
    await expect(service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://new-endpoint.example.com/v1',
      model: 'new-model',
      apiKey: '',
    })).rejects.toThrow('请填写验证模型 API Key');
  });

  it('同一服务商换端点和密钥时运行时不会读到旧端点与新密钥', async () => {
    const repository = new MemorySettingsRepository({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://old-endpoint.example.com/v1',
      model: 'old-model',
      credentialTargetConfirmed: true,
    });
    const gatedStore = new GatedSetApiKeyStore('sk-old-endpoint');
    const stores = {
      ...keyStores(),
      'openai-compatible': gatedStore,
    };
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    const saving = service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://new-endpoint.example.com/v1',
      model: 'new-model',
      apiKey: 'sk-new-endpoint',
    });
    await gatedStore.waitUntilSetStarted();
    let runtimeSettled = false;
    const runtime = service.getRuntimeConfig().finally(() => {
      runtimeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeCredentialSaveCompleted = runtimeSettled;

    gatedStore.continueSet();
    await saving;

    expect(settledBeforeCredentialSaveCompleted).toBe(false);
    await expect(runtime).resolves.toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://new-endpoint.example.com/v1',
      model: 'new-model',
      apiKey: 'sk-new-endpoint',
    });
  });

  it('切回固定端点的 DeepSeek 时可安全复用 DeepSeek 独立凭据', async () => {
    const repository = new MemorySettingsRepository({
      enabled: true,
      provider: 'aliyun-bailian',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      credentialTargetConfirmed: true,
    });
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-existing-deepseek';
    stores['aliyun-bailian'].apiKey = 'sk-existing-bailian';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await service.saveSettings({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: '',
    });

    expect(repository.record?.provider).toBe('deepseek');
    expect(stores.deepseek.apiKey).toBe('sk-existing-deepseek');
    expect(stores['aliyun-bailian'].apiKey).toBe('sk-existing-bailian');
  });

  it('候选裁决关闭时即使已有独立凭据也不返回运行时配置', async () => {
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-configured-but-disabled';
    const service = new CandidateVerificationSettingsService(
      new MemorySettingsRepository({
        enabled: false,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        credentialTargetConfirmed: true,
      }),
      stores,
      unusedTester,
    );

    await expect(service.getRuntimeConfig()).resolves.toBeNull();
  });

  it('候选裁决开启且当前服务商凭据存在时才返回运行时配置', async () => {
    const stores = keyStores();
    stores['openai-compatible'].apiKey = 'sk-local-runtime';
    const service = new CandidateVerificationSettingsService(
      new MemorySettingsRepository({
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'local-verifier',
        credentialTargetConfirmed: true,
      }),
      stores,
      unusedTester,
    );

    await expect(service.getRuntimeConfig()).resolves.toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-verifier',
      apiKey: 'sk-local-runtime',
    });
  });

  it('移除当前验证密钥时同时关闭候选裁决', async () => {
    const repository = new MemorySettingsRepository({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      credentialTargetConfirmed: true,
    });
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-to-remove';
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(service.removeApiKey()).resolves.toMatchObject({
      enabled: false,
      apiKeyConfigured: false,
    });
    expect(repository.record?.enabled).toBe(false);
    expect(stores.deepseek.apiKey).toBeNull();
  });

  it('独立连接测试只在用户确认可能产生文本模型费用后调用当前服务', async () => {
    const stores = keyStores();
    stores['aliyun-bailian'].apiKey = 'sk-bailian-test-only';
    const testConnection = vi.fn(async (input: { model: string }) => ({
      model: input.model,
    }));
    const service = new CandidateVerificationSettingsService(
      new MemorySettingsRepository({
        enabled: false,
        provider: 'aliyun-bailian',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        credentialTargetConfirmed: true,
      }),
      stores,
      { testConnection },
    );

    await expect(
      service.testConnection({ consentToPaidCall: false }, immediatePaidOperation),
    ).rejects.toThrow('请先确认本次测试会产生一次文本模型调用');
    expect(testConnection).not.toHaveBeenCalled();

    await expect(
      service.testConnection({ consentToPaidCall: true }, immediatePaidOperation),
    ).resolves.toEqual({
      ok: true,
      provider: 'aliyun-bailian',
      model: 'qwen-plus',
      message: '连接成功，qwen-plus 可以用于候选裁决',
    });
    expect(testConnection).toHaveBeenCalledWith({
      provider: 'aliyun-bailian',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: 'sk-bailian-test-only',
    });
  });

  it('重启后恢复非敏感配置且配置文件中不出现 API Key', async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'xianyu-candidate-verification-settings-'),
    );
    const sentinelApiKey = 'sk-never-in-settings-file';
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      new CandidateVerificationSettingsFile(configDirectory),
      stores,
      unusedTester,
    );

    await service.saveSettings({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1/',
      model: 'verifier-v1',
      apiKey: sentinelApiKey,
    });

    const persisted = await readFile(
      join(configDirectory, 'candidate-verification-settings.json'),
      'utf8',
    );
    expect(persisted).toContain('https://models.example.com/v1');
    expect(persisted).not.toContain(sentinelApiKey);

    const reopened = new CandidateVerificationSettingsService(
      new CandidateVerificationSettingsFile(configDirectory),
      stores,
      unusedTester,
    );
    await expect(reopened.getSettings()).resolves.toMatchObject({
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://models.example.com/v1',
      model: 'verifier-v1',
      apiKeyConfigured: true,
    });
  });

  it('非敏感配置写入失败时恢复当前服务商原有 API Key', async () => {
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-before-failed-write';
    const repository: CandidateVerificationSettingsRepository = {
      read: () => ({
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        credentialTargetConfirmed: true,
      }),
      write: () => {
        throw new Error('disk failure with private path');
      },
    };
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(
      service.saveSettings({
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-after-failed-write',
      }),
    ).rejects.toThrow('无法保存候选裁决设置，请重试');

    expect(stores.deepseek.apiKey).toBe('sk-before-failed-write');
  });

  it('移除 API Key 时只移除当前服务商的独立凭据', async () => {
    const stores = keyStores();
    stores.deepseek.apiKey = 'sk-deepseek-keep';
    stores['openai-compatible'].apiKey = 'sk-custom-remove';
    const service = new CandidateVerificationSettingsService(
      new MemorySettingsRepository({
        enabled: false,
        provider: 'openai-compatible',
        baseUrl: 'https://models.example.com/v1',
        model: 'verifier-v1',
        credentialTargetConfirmed: true,
      }),
      stores,
      unusedTester,
    );

    const view = await service.removeApiKey();

    expect(stores['openai-compatible'].apiKey).toBeNull();
    expect(stores.deepseek.apiKey).toBe('sk-deepseek-keep');
    expect(view).toMatchObject({
      provider: 'openai-compatible',
      apiKeyConfigured: false,
      apiKeyMask: '',
    });
  });

  it('保存前拒绝空的验证模型名称', async () => {
    const repository = new MemorySettingsRepository();
    const stores = keyStores();
    const service = new CandidateVerificationSettingsService(
      repository,
      stores,
      unusedTester,
    );

    await expect(
      service.saveSettings({
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'https://models.example.com/v1',
        model: '   ',
        apiKey: 'sk-must-not-save-without-model',
      }),
    ).rejects.toThrow('验证模型名称不能为空');

    expect(repository.record).toBeNull();
    expect(stores['openai-compatible'].apiKey).toBeNull();
  });
});
