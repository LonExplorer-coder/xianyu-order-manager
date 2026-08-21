import {
  DEFAULT_CANDIDATE_VERIFICATION_SETTINGS,
  normalizeCandidateVerificationApiKey,
  normalizeCandidateVerificationBaseUrl,
  normalizeCandidateVerificationModel,
  type CandidateVerificationConnectionTestInput,
  type CandidateVerificationConnectionTestResult,
  type CandidateVerificationProvider,
  type CandidateVerificationRuntimeConfig,
  type CandidateVerificationSettingsView,
  type SaveCandidateVerificationSettingsInput,
} from '../core/candidate-verification-settings';
import type { OcrPaidOperationRunner } from './ocr-usage-service';

export type CandidateVerificationSettingsRecord = {
  enabled: boolean;
  provider: CandidateVerificationProvider;
  baseUrl: string;
  model: string;
  credentialTargetConfirmed: boolean;
};

export interface CandidateVerificationSettingsRepository {
  read(): CandidateVerificationSettingsRecord | null;
  write(record: CandidateVerificationSettingsRecord): void;
}

export interface CandidateVerificationApiKeyStore {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  getDisplayName(): string;
}

export interface CandidateVerificationConnectionTester {
  testConnection(input: {
    provider: CandidateVerificationProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
  }): Promise<{ model: string }>;
}

export type CandidateVerificationApiKeyStores = Record<
  CandidateVerificationProvider,
  CandidateVerificationApiKeyStore
>;

export class CandidateVerificationSettingsService {
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: CandidateVerificationSettingsRepository,
    private readonly apiKeyStores: CandidateVerificationApiKeyStores,
    private readonly connectionTester: CandidateVerificationConnectionTester,
  ) {}

  public getSettings(): Promise<CandidateVerificationSettingsView> {
    return this.withExclusiveAccess(() => this.getSettingsUnlocked());
  }

  private async getSettingsUnlocked(): Promise<CandidateVerificationSettingsView> {
    const record = this.repository.read() ?? DEFAULT_CANDIDATE_VERIFICATION_SETTINGS;
    const apiKeyStore = this.apiKeyStores[record.provider];
    const apiKey = await apiKeyStore.getApiKey();
    const apiKeyConfigured = record.credentialTargetConfirmed && Boolean(apiKey);
    return {
      enabled: record.enabled,
      provider: record.provider,
      baseUrl: record.baseUrl,
      baseUrlLocked: record.provider === 'deepseek',
      model: record.model,
      apiKeyConfigured,
      apiKeyMask: apiKeyConfigured ? '••••••••' : '',
      credentialStore: apiKeyStore.getDisplayName(),
    };
  }

  public saveSettings(
    input: SaveCandidateVerificationSettingsInput,
  ): Promise<CandidateVerificationSettingsView> {
    return this.withExclusiveAccess(() => this.saveSettingsUnlocked(input));
  }

  private async saveSettingsUnlocked(
    input: SaveCandidateVerificationSettingsInput,
  ): Promise<CandidateVerificationSettingsView> {
    const baseUrl = normalizeCandidateVerificationBaseUrl(
      input.provider,
      input.baseUrl,
    );
    const apiKey = normalizeCandidateVerificationApiKey(input.apiKey);
    const model = normalizeCandidateVerificationModel(input.model);
    const apiKeyStore = this.apiKeyStores[input.provider];
    const currentRecord = this.repository.read();
    const sameRecordedTarget =
      currentRecord !== null &&
      currentRecord.provider === input.provider &&
      currentRecord.baseUrl === baseUrl;
    const targetChanged = currentRecord !== null && !sameRecordedTarget;
    const existingTargetApiKey = await apiKeyStore.getApiKey();
    const canSafelyReuseTargetCredential =
      Boolean(existingTargetApiKey) &&
      (
        input.provider === 'deepseek' ||
        (sameRecordedTarget && currentRecord.credentialTargetConfirmed)
      );
    if (
      input.enabled &&
      !apiKey &&
      targetChanged &&
      !canSafelyReuseTargetCredential
    ) {
      throw new Error(
        '更换服务商或 Base URL 时，请重新填写验证模型 API Key',
      );
    }
    if (!apiKey && input.enabled && !canSafelyReuseTargetCredential) {
      throw new Error('请填写验证模型 API Key');
    }
    const nextRecord: CandidateVerificationSettingsRecord = {
      enabled: input.enabled,
      provider: input.provider,
      baseUrl,
      model,
      credentialTargetConfirmed: Boolean(apiKey) || canSafelyReuseTargetCredential,
    };
    const requiresCredentialRebinding =
      input.provider !== 'deepseek' && !sameRecordedTarget;
    if (apiKey && requiresCredentialRebinding) {
      try {
        this.repository.write({
          ...nextRecord,
          enabled: false,
          credentialTargetConfirmed: false,
        });
      } catch {
        throw new Error('无法保存候选裁决设置，请重试');
      }
      try {
        await apiKeyStore.setApiKey(apiKey);
        this.repository.write(nextRecord);
      } catch {
        throw new Error('无法绑定新的候选裁决端点，设置已保持关闭');
      }
      return this.getSettingsUnlocked();
    }

    if (apiKey) await apiKeyStore.setApiKey(apiKey);
    try {
      this.repository.write(nextRecord);
    } catch {
      if (apiKey) {
        await this.restoreApiKey(apiKeyStore, existingTargetApiKey);
      }
      throw new Error('无法保存候选裁决设置，请重试');
    }
    return this.getSettingsUnlocked();
  }

  public getRuntimeConfig(): Promise<CandidateVerificationRuntimeConfig | null> {
    return this.withExclusiveAccess(() => this.getRuntimeConfigUnlocked());
  }

  private async getRuntimeConfigUnlocked(): Promise<CandidateVerificationRuntimeConfig | null> {
    const record = this.repository.read();
    if (!record?.enabled || !record.credentialTargetConfirmed) return null;
    const apiKey = await this.apiKeyStores[record.provider].getApiKey();
    if (!apiKey) return null;
    return {
      provider: record.provider,
      baseUrl: record.baseUrl,
      model: record.model,
      apiKey,
    };
  }

  public removeApiKey(): Promise<CandidateVerificationSettingsView> {
    return this.withExclusiveAccess(() => this.removeApiKeyUnlocked());
  }

  private async removeApiKeyUnlocked(): Promise<CandidateVerificationSettingsView> {
    const record = this.repository.read() ?? DEFAULT_CANDIDATE_VERIFICATION_SETTINGS;
    const apiKeyStore = this.apiKeyStores[record.provider];
    const existingApiKey = await apiKeyStore.getApiKey();
    await apiKeyStore.deleteApiKey();
    try {
      this.repository.write({
        ...record,
        enabled: false,
        credentialTargetConfirmed: false,
      });
    } catch {
      await this.restoreApiKey(apiKeyStore, existingApiKey);
      throw new Error('无法移除候选裁决 API Key，请重试');
    }
    return this.getSettingsUnlocked();
  }

  public testConnection(
    input: CandidateVerificationConnectionTestInput,
    usage: OcrPaidOperationRunner,
  ): Promise<CandidateVerificationConnectionTestResult> {
    return this.withExclusiveAccess(() => this.testConnectionUnlocked(input, usage));
  }

  private async testConnectionUnlocked(
    input: CandidateVerificationConnectionTestInput,
    usage: OcrPaidOperationRunner,
  ): Promise<CandidateVerificationConnectionTestResult> {
    if (input.consentToPaidCall !== true) {
      throw new Error(
        '请先确认本次测试会产生一次文本模型调用',
      );
    }
    const record = this.repository.read();
    if (!record) throw new Error('请先保存候选裁决配置');
    if (!record.credentialTargetConfirmed) {
      throw new Error('请重新填写当前端点的 API Key');
    }
    const apiKey = await this.apiKeyStores[record.provider].getApiKey();
    if (!apiKey) throw new Error('请先保存当前服务商的 API Key');
    const test = () => this.connectionTester.testConnection({
      provider: record.provider,
      baseUrl: record.baseUrl,
      model: record.model,
      apiKey,
    });
    const result = await usage.runPaidOperation(test);
    return {
      ok: true,
      provider: record.provider,
      model: result.model,
      message: `连接成功，${result.model} 可以用于候选裁决`,
    };
  }

  private async restoreApiKey(
    apiKeyStore: CandidateVerificationApiKeyStore,
    previousApiKey: string | null,
  ): Promise<void> {
    try {
      if (previousApiKey) {
        await apiKeyStore.setApiKey(previousApiKey);
      } else {
        await apiKeyStore.deleteApiKey();
      }
    } catch {
      throw new Error('无法保存候选裁决设置，系统凭据恢复失败');
    }
  }

  private withExclusiveAccess<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type {
  CandidateVerificationConnectionTestInput,
  CandidateVerificationConnectionTestResult,
  CandidateVerificationProvider,
  CandidateVerificationRuntimeConfig,
  CandidateVerificationSettingsView,
  SaveCandidateVerificationSettingsInput,
} from '../core/candidate-verification-settings';
