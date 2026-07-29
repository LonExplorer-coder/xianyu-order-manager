export type BailianRegion = 'cn-beijing';

export type BailianRecognitionCredentials = {
  workspaceId: string;
  region: BailianRegion;
  apiKey: string;
};

const BAILIAN_WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function normalizeBailianWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!BAILIAN_WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error('Workspace ID 格式无效');
  }
  return normalized;
}

export type OcrSettingsView = {
  workspaceId: string;
  region: BailianRegion;
  regionLabel: string;
  model: 'qwen3.5-ocr';
  apiKeyConfigured: boolean;
  apiKeyMask: string;
  credentialStore: string;
};

export type SaveOcrSettingsInput = {
  workspaceId: string;
  region: BailianRegion;
  apiKey: string;
};

export type OcrConnectionTestInput = {
  consentToPaidCall: boolean;
};

export type OcrConnectionTestResult = {
  ok: true;
  model: 'qwen3.5-ocr';
  message: string;
};
