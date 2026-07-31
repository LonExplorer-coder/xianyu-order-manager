import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopSession } from '../src/main/desktop-session';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return { isDestroyed: () => false }; }
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

afterEach(() => electronBoundary.handlers.clear());

describe('候选裁决 Electron IPC', () => {
  it('仅接受精确的候选设置字段并拒绝控制字符', async () => {
    const saveCandidateVerificationSettings = vi.fn(async (input) => input);
    registerIpcHandlers({
      onOrdersChanged: vi.fn(),
      onRecognitionBatchesChanged: vi.fn(),
      saveCandidateVerificationSettings,
    } as unknown as DesktopSession);
    const valid = {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-independent',
    };

    await expect(invoke('settings:save-candidate-verification', {
      ...valid,
      unexpected: true,
    })).rejects.toThrow('候选裁决设置包含未知字段');
    await expect(invoke('settings:save-candidate-verification', {
      ...valid,
      model: 'deepseek\nmalicious',
    })).rejects.toThrow('候选裁决模型名称格式无效');
    await expect(invoke('settings:save-candidate-verification', {
      ...valid,
      apiKey: 'sk-safe\rInjected: true',
    })).rejects.toThrow('候选裁决API Key格式无效');
    expect(saveCandidateVerificationSettings).not.toHaveBeenCalled();

    await invoke('settings:save-candidate-verification', valid);
    expect(saveCandidateVerificationSettings).toHaveBeenCalledWith(valid);
  });

  it('连接测试确认只接受唯一必需字段', async () => {
    const testCandidateVerificationConnection = vi.fn(async () => ({ ok: true }));
    registerIpcHandlers({
      onOrdersChanged: vi.fn(),
      onRecognitionBatchesChanged: vi.fn(),
      testCandidateVerificationConnection,
    } as unknown as DesktopSession);

    await expect(invoke('settings:test-candidate-verification', {
      consentToPaidCall: true,
      unexpected: true,
    })).rejects.toThrow('候选裁决连接测试包含未知字段');
    expect(testCandidateVerificationConnection).not.toHaveBeenCalled();

    await invoke('settings:test-candidate-verification', {
      consentToPaidCall: true,
    });
    expect(testCandidateVerificationConnection).toHaveBeenCalledWith({
      consentToPaidCall: true,
    });
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
