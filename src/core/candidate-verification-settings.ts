export type CandidateVerificationProvider =
  | 'deepseek'
  | 'aliyun-bailian'
  | 'openai-compatible';

export const DEFAULT_CANDIDATE_VERIFICATION_SETTINGS = {
  enabled: false,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  credentialTargetConfirmed: true,
} as const;

export function normalizeCandidateVerificationBaseUrl(
  provider: CandidateVerificationProvider,
  value: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Base URL 不能包含用户名、密码、查询参数或片段');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Base URL 只支持 HTTP 或 HTTPS');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('非本机 Base URL 必须使用 HTTPS');
  }
  parsed.pathname = parsed.pathname.replace(/\/chat\/completions\/?$/u, '') || '/';
  const normalized = parsed.toString().replace(/\/+$/, '');
  if (
    provider === 'deepseek' &&
    normalized !== DEFAULT_CANDIDATE_VERIFICATION_SETTINGS.baseUrl
  ) {
    throw new Error('DeepSeek Base URL 固定为 https://api.deepseek.com');
  }
  return normalized;
}

export function normalizeCandidateVerificationModel(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('验证模型名称不能为空');
  if (value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('验证模型名称格式无效');
  }
  return normalized;
}

export function normalizeCandidateVerificationApiKey(value: string): string {
  if (value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('验证模型 API Key 格式无效');
  }
  return value.trim();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1'
  ) {
    return true;
  }
  const ipv4Parts = normalized.split('.');
  return (
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === '127' &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export type CandidateVerificationSettingsView = {
  enabled: boolean;
  provider: CandidateVerificationProvider;
  baseUrl: string;
  baseUrlLocked: boolean;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyMask: string;
  credentialStore: string;
};

export type SaveCandidateVerificationSettingsInput = {
  enabled: boolean;
  provider: CandidateVerificationProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type CandidateVerificationRuntimeConfig = {
  provider: CandidateVerificationProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type CandidateVerificationConnectionTestInput = {
  consentToPaidCall: boolean;
};

export type CandidateVerificationConnectionTestResult = {
  ok: true;
  provider: CandidateVerificationProvider;
  model: string;
  message: string;
};
