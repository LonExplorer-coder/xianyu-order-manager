import { AsyncEntry } from '@napi-rs/keyring';

import type { ApiKeyStore } from '../../main/ocr-settings';

const SERVICE_NAME = 'com.lonexplorer.xianyu-order-manager';
const ACCOUNT_NAME = 'aliyun-bailian-api-key';

export class SystemApiKeyStore implements ApiKeyStore {
  private readonly entry = new AsyncEntry(SERVICE_NAME, ACCOUNT_NAME);

  public async getApiKey(): Promise<string | null> {
    try {
      return (await this.entry.getPassword()) ?? null;
    } catch {
      throw new Error('无法读取系统凭据库中的百炼 API Key');
    }
  }

  public async setApiKey(apiKey: string): Promise<void> {
    try {
      await this.entry.setPassword(apiKey);
    } catch {
      throw new Error('无法把百炼 API Key 保存到系统凭据库');
    }
  }

  public async deleteApiKey(): Promise<void> {
    try {
      if (!(await this.entry.getPassword())) return;
      await this.entry.deleteCredential();
    } catch {
      throw new Error('无法从系统凭据库移除百炼 API Key');
    }
  }

  public getDisplayName(): string {
    if (process.platform === 'darwin') return 'macOS 钥匙串';
    if (process.platform === 'win32') return 'Windows 凭据管理器';
    return '系统凭据库';
  }
}
