import { execFile } from 'node:child_process';

import {
  AsyncEntry,
  findCredentialsAsync,
  type Credential,
} from '@napi-rs/keyring';

import type { ApiKeyStore } from '../../main/ocr-settings';

const SERVICE_NAME = 'com.lonexplorer.xianyu-order-manager';
const ACCOUNT_NAME = 'aliyun-bailian-api-key';

export type SystemCredentialEntry = {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
};

export type SystemCredentialReadResult =
  | { status: 'found'; password: string }
  | { status: 'not-found' };

export type SystemCredentialBackend = {
  readCredential(): Promise<SystemCredentialReadResult>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
};

export type SystemApiKeyStoreOptions = {
  serviceName?: string;
  accountName?: string;
  backend?: SystemCredentialBackend;
  platform?: NodeJS.Platform;
  entry?: SystemCredentialEntry;
  findCredentials?: (serviceName: string) => Promise<Credential[]>;
  runMacOsSecurity?: (args: string[]) => Promise<void>;
};

export class SystemApiKeyStore implements ApiKeyStore {
  private readonly backend: SystemCredentialBackend;

  public constructor(options: SystemApiKeyStoreOptions = {}) {
    const serviceName = options.serviceName ?? SERVICE_NAME;
    const accountName = options.accountName ?? ACCOUNT_NAME;
    this.backend = options.backend ?? createSystemCredentialBackend({
      serviceName,
      accountName,
      platform: options.platform ?? process.platform,
      entry: options.entry ?? new AsyncEntry(serviceName, accountName),
      findCredentials: options.findCredentials ?? findCredentialsAsync,
      runMacOsSecurity: options.runMacOsSecurity ?? runMacOsSecurity,
    });
  }

  public async getApiKey(): Promise<string | null> {
    try {
      const result = await this.backend.readCredential();
      return result.status === 'found' ? result.password : null;
    } catch {
      throw new Error('无法读取系统凭据库中的百炼 API Key');
    }
  }

  public async setApiKey(apiKey: string): Promise<void> {
    try {
      await this.backend.setPassword(apiKey);
    } catch {
      throw new Error('无法把百炼 API Key 保存到系统凭据库');
    }
  }

  public async deleteApiKey(): Promise<void> {
    try {
      const existing = await this.backend.readCredential();
      if (existing.status === 'not-found') return;
      if (!(await this.backend.deleteCredential())) {
        throw new Error('系统凭据库拒绝删除条目');
      }
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

type DefaultBackendOptions = {
  serviceName: string;
  accountName: string;
  platform: NodeJS.Platform;
  entry: SystemCredentialEntry;
  findCredentials(serviceName: string): Promise<Credential[]>;
  runMacOsSecurity(args: string[]): Promise<void>;
};

function createSystemCredentialBackend(
  options: DefaultBackendOptions,
): SystemCredentialBackend {
  return {
    async readCredential(): Promise<SystemCredentialReadResult> {
      if (options.platform === 'darwin') {
        const presence = await probeMacOsCredential(
          options.serviceName,
          options.accountName,
          options.runMacOsSecurity,
        );
        if (presence === 'not-found') return { status: 'not-found' };

        // @napi-rs/keyring 1.3.0 会把 NoEntry 与权限/读取错误都折叠为 undefined。
        // 先用不读取密码的系统精确查询确认条目存在，此时 undefined 只能按读取失败处理。
        const password = await options.entry.getPassword();
        if (password === undefined) throw new Error('系统凭据存在但无法读取');
        return { status: 'found', password };
      }

      const credentials = (await options.findCredentials(options.serviceName)).filter(
        (credential) => credential.account === options.accountName,
      );
      if (credentials.length > 1) throw new Error('系统凭据存在重复条目');
      const credential = credentials[0];
      return credential
        ? { status: 'found', password: credential.password }
        : { status: 'not-found' };
    },
    setPassword(password: string): Promise<void> {
      return options.entry.setPassword(password);
    },
    deleteCredential(): Promise<boolean> {
      return options.entry.deleteCredential();
    },
  };
}

async function probeMacOsCredential(
  serviceName: string,
  accountName: string,
  runSecurity: (args: string[]) => Promise<void>,
): Promise<'found' | 'not-found'> {
  try {
    await runSecurity([
      'find-generic-password',
      '-s',
      serviceName,
      '-a',
      accountName,
    ]);
    return 'found';
  } catch (error) {
    if (isMacOsItemNotFound(error)) return 'not-found';
    throw error;
  }
}

function runMacOsSecurity(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function isMacOsItemNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 44;
}
