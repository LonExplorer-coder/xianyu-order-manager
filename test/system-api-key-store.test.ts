import { describe, expect, it, vi } from 'vitest';

import {
  SystemApiKeyStore,
  type SystemCredentialBackend,
  type SystemCredentialEntry,
} from '../src/adapters/credentials/system-api-key-store';

function entry(overrides: Partial<SystemCredentialEntry> = {}): SystemCredentialEntry {
  return {
    getPassword: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    deleteCredential: vi.fn(async () => true),
    ...overrides,
  };
}

function backend(
  overrides: Partial<SystemCredentialBackend> = {},
): SystemCredentialBackend {
  return {
    readCredential: vi.fn(async () => ({ status: 'not-found' as const })),
    setPassword: vi.fn(async () => undefined),
    deleteCredential: vi.fn(async () => true),
    ...overrides,
  };
}

describe('系统 API Key 凭据库适配器', () => {
  it('候选裁决凭据可使用独立账号并在错误中显示对应秘密名称', async () => {
    const store = new SystemApiKeyStore({
      accountName: 'candidate-verification-deepseek-api-key',
      secretLabel: 'DeepSeek 验证模型 API Key',
      backend: backend({
        setPassword: vi.fn(async () => {
          throw new Error('native access denied');
        }),
      }),
    });

    await expect(store.setApiKey('sk-independent-verifier')).rejects.toThrow(
      '无法把 DeepSeek 验证模型 API Key 保存到系统凭据库',
    );
  });

  it('通过可报告错误的系统枚举读取精确账号，不混用同服务其他凭据', async () => {
    const store = new SystemApiKeyStore({
      platform: 'win32',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: entry(),
      findCredentials: vi.fn(async () => [
        { account: 'other', password: 'other-secret' },
        { account: 'aliyun-key', password: 'expected-secret' },
      ]),
    });

    await expect(store.getApiKey()).resolves.toBe('expected-secret');
  });

  it('系统凭据枚举失败时明确报错，不伪装成未配置', async () => {
    const store = new SystemApiKeyStore({
      platform: 'win32',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: entry(),
      findCredentials: vi.fn(async () => {
        throw new Error('native access denied');
      }),
    });

    await expect(store.getApiKey()).rejects.toThrow('无法读取系统凭据库中的百炼 API Key');
  });

  it('macOS 已存在条目的密码读取被吞错时不误报为未配置', async () => {
    const credentialEntry = entry({
      getPassword: vi.fn(async () => undefined),
    });
    const store = new SystemApiKeyStore({
      platform: 'darwin',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: credentialEntry,
      findCredentials: vi.fn(async () => []),
      runMacOsSecurity: vi.fn(async () => undefined),
    });

    await expect(store.getApiKey()).rejects.toThrow('无法读取系统凭据库中的百炼 API Key');
  });

  it('macOS 精确查询确认不存在时才返回未配置', async () => {
    const credentialEntry = entry();
    const notFound = Object.assign(new Error('item not found'), { code: 44 });
    const store = new SystemApiKeyStore({
      platform: 'darwin',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: credentialEntry,
      runMacOsSecurity: vi.fn(async () => {
        throw notFound;
      }),
    });

    await expect(store.getApiKey()).resolves.toBeNull();
    expect(credentialEntry.getPassword).not.toHaveBeenCalled();
  });

  it('macOS 精确查询的权限失败保持为读取错误', async () => {
    const credentialEntry = entry();
    const accessDenied = Object.assign(new Error('access denied'), { code: 36 });
    const store = new SystemApiKeyStore({
      platform: 'darwin',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: credentialEntry,
      runMacOsSecurity: vi.fn(async () => {
        throw accessDenied;
      }),
    });

    await expect(store.getApiKey()).rejects.toThrow('无法读取系统凭据库中的百炼 API Key');
    expect(credentialEntry.getPassword).not.toHaveBeenCalled();
  });

  it('macOS 精确查询确认存在后返回原生读取的密码', async () => {
    const store = new SystemApiKeyStore({
      platform: 'darwin',
      serviceName: 'test-service',
      accountName: 'aliyun-key',
      entry: entry({
        getPassword: vi.fn(async () => 'expected-secret'),
      }),
      runMacOsSecurity: vi.fn(async () => undefined),
    });

    await expect(store.getApiKey()).resolves.toBe('expected-secret');
  });

  it('系统返回删除失败时阻止界面误报已移除', async () => {
    const credentialBackend = backend({
      readCredential: vi.fn(async () => ({
        status: 'found' as const,
        password: 'secret-to-delete',
      })),
      deleteCredential: vi.fn(async () => false),
    });
    const store = new SystemApiKeyStore({
      backend: credentialBackend,
    });

    await expect(store.deleteApiKey()).rejects.toThrow('无法从系统凭据库移除百炼 API Key');
    expect(credentialBackend.deleteCredential).toHaveBeenCalledOnce();
  });

  it('凭据本就不存在时删除保持幂等且不调用原生删除', async () => {
    const credentialBackend = backend();
    const store = new SystemApiKeyStore({
      backend: credentialBackend,
    });

    await expect(store.deleteApiKey()).resolves.toBeUndefined();
    expect(credentialBackend.deleteCredential).not.toHaveBeenCalled();
  });

  it('删除前的读取失败不降级为已经不存在', async () => {
    const credentialBackend = backend({
      readCredential: vi.fn(async () => {
        throw new Error('native access denied');
      }),
    });
    const store = new SystemApiKeyStore({
      backend: credentialBackend,
    });

    await expect(store.deleteApiKey()).rejects.toThrow('无法从系统凭据库移除百炼 API Key');
    expect(credentialBackend.deleteCredential).not.toHaveBeenCalled();
  });
});
