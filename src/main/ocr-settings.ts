import type {
  BailianRecognitionCredentials,
  BailianRegion,
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import { normalizeBailianWorkspaceId } from '../core/ocr-settings';

export type OcrSettingsRecord = {
  workspaceId: string;
  region: BailianRegion;
};

export interface OcrSettingsRepository {
  read(): OcrSettingsRecord | null;
  write(record: OcrSettingsRecord): void;
}

export type {
  BailianRegion,
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';

export interface ApiKeyStore {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  getDisplayName(): string;
}

export interface BailianConnectionTester {
  testConnection(input: {
    workspaceId: string;
    region: BailianRegion;
    apiKey: string;
  }): Promise<{ model: 'qwen3.5-ocr' }>;
}

export class OcrSettingsService {
  public constructor(
    private readonly repository: OcrSettingsRepository,
    private readonly apiKeyStore: ApiKeyStore,
    private readonly connectionTester: BailianConnectionTester,
  ) {}

  public async getSettings(): Promise<OcrSettingsView> {
    const record = this.repository.read();
    const apiKey = await this.apiKeyStore.getApiKey();
    return {
      workspaceId: record?.workspaceId ?? '',
      region: record?.region ?? 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: Boolean(apiKey),
      apiKeyMask: apiKey ? '••••••••' : '',
      credentialStore: this.apiKeyStore.getDisplayName(),
    };
  }

  public async saveSettings(input: SaveOcrSettingsInput): Promise<OcrSettingsView> {
    const workspaceId = normalizeBailianWorkspaceId(input.workspaceId);
    const apiKey = input.apiKey.trim();
    if (input.region !== 'cn-beijing') throw new Error('当前暂不支持该百炼地域');
    if (apiKey.length > 4_096) throw new Error('API Key 格式无效');
    const currentRecord = this.repository.read();
    const existingApiKey = await this.apiKeyStore.getApiKey();
    if (!apiKey && !existingApiKey) throw new Error('请输入百炼 API Key');
    if (
      !apiKey &&
      currentRecord &&
      (currentRecord.workspaceId !== workspaceId || currentRecord.region !== input.region)
    ) {
      throw new Error('更换 Workspace ID 或地域时，请重新填写 API Key');
    }

    if (apiKey) await this.apiKeyStore.setApiKey(apiKey);
    try {
      this.repository.write({ workspaceId, region: input.region });
    } catch {
      if (apiKey) await this.restoreApiKey(existingApiKey);
      throw new Error('无法保存 OCR 设置，请重试');
    }
    return this.getSettings();
  }

  public async removeApiKey(): Promise<OcrSettingsView> {
    await this.apiKeyStore.deleteApiKey();
    return this.getSettings();
  }

  public async testConnection(
    input: OcrConnectionTestInput,
  ): Promise<OcrConnectionTestResult> {
    if (input.consentToPaidCall !== true) {
      throw new Error('请先确认本次测试会产生一次 OCR 调用');
    }
    const record = this.repository.read();
    if (!record) throw new Error('请先保存百炼 OCR 配置');
    const apiKey = await this.apiKeyStore.getApiKey();
    if (!apiKey) throw new Error('请先保存百炼 API Key');

    const result = await this.connectionTester.testConnection({
      workspaceId: record.workspaceId,
      region: record.region,
      apiKey,
    });
    return {
      ok: true,
      model: result.model,
      message: '连接成功，qwen3.5-ocr 可以使用',
    };
  }

  public async getRecognitionCredentials(): Promise<BailianRecognitionCredentials> {
    const record = this.repository.read();
    const apiKey = await this.apiKeyStore.getApiKey();
    if (!record || !apiKey) {
      throw new Error('请先在设置中保存百炼 OCR 配置和 API Key');
    }
    return {
      workspaceId: record.workspaceId,
      region: record.region,
      apiKey,
    };
  }

  private async restoreApiKey(previousApiKey: string | null): Promise<void> {
    try {
      if (previousApiKey) {
        await this.apiKeyStore.setApiKey(previousApiKey);
      } else {
        await this.apiKeyStore.deleteApiKey();
      }
    } catch {
      throw new Error('无法保存 OCR 设置，系统凭据恢复失败');
    }
  }
}
