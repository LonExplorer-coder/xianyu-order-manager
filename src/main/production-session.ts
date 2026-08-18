import {
  BailianOcrClient,
  type FetchLike,
} from '../adapters/recognition/bailian-ocr-client';
import { ConfiguredBailianRecognizer } from '../adapters/recognition/configured-bailian-recognizer';
import { OpenAICompatibleCandidateAdjudicator } from '../adapters/recognition/openai-compatible-candidate-adjudicator';
import {
  DesktopSession,
  type DataDirectoryValidator,
} from './desktop-session';
import { OcrSettingsFile } from './ocr-settings-file';
import { OcrSettingsService, type ApiKeyStore } from './ocr-settings';
import { CandidateVerificationSettingsFile } from './candidate-verification-settings-file';
import {
  CandidateVerificationSettingsService,
  type CandidateVerificationApiKeyStores,
} from './candidate-verification-settings';
import { Preferences } from './preferences';
import { BackupSettingsFile } from './backup-settings-file';

export function createConfiguredDesktopSession(input: {
  configDirectory: string;
  apiKeyStore: ApiKeyStore;
  candidateVerificationApiKeyStores?: CandidateVerificationApiKeyStores;
  request?: FetchLike;
  validateDataDirectory?: DataDirectoryValidator;
}): DesktopSession {
  const client = new BailianOcrClient(input.request);
  const ocrSettings = new OcrSettingsService(
    new OcrSettingsFile(input.configDirectory),
    input.apiKeyStore,
    client,
  );
  const candidateVerificationSettings = new CandidateVerificationSettingsService(
    new CandidateVerificationSettingsFile(input.configDirectory),
    input.candidateVerificationApiKeyStores ?? unavailableCandidateApiKeyStores(),
    {
      testConnection: async (configuration) => {
        const result = await new OpenAICompatibleCandidateAdjudicator({
          ...configuration,
          fetcher: input.request,
        }).testConnection();
        if (!result.ok) throw new Error(result.failure.message);
        return { model: result.model };
      },
    },
  );
  const recognizer = new ConfiguredBailianRecognizer(
    ocrSettings,
    client,
    '默认闲鱼账号',
    candidateVerificationSettings,
    (configuration) => new OpenAICompatibleCandidateAdjudicator({
      ...configuration,
      fetcher: input.request,
    }),
  );
  return new DesktopSession(
    new Preferences(input.configDirectory),
    recognizer,
    ocrSettings,
    input.validateDataDirectory,
    candidateVerificationSettings,
    new BackupSettingsFile(input.configDirectory),
  );
}

function unavailableCandidateApiKeyStores(): CandidateVerificationApiKeyStores {
  const createStore = (): ApiKeyStore => ({
    getApiKey: async () => null,
    setApiKey: async () => {
      throw new Error('当前运行环境未配置候选裁决系统凭据库');
    },
    deleteApiKey: async () => undefined,
    getDisplayName: () => '系统凭据库',
  });
  return {
    deepseek: createStore(),
    'aliyun-bailian': createStore(),
    'openai-compatible': createStore(),
  };
}
