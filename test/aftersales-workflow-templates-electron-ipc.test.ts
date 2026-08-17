import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

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

const sessions: DesktopSession[] = [];
const unusedRecognition: RecognitionResult = {
  platform: 'xianyu', sellerAccount: '默认闲鱼账号', orderNumber: 'unused',
  alipayTransactionNumber: '', buyerNickname: '', recipient: 'unused', phone: 'unused',
  phoneNormalized: '', addressOriginal: 'unused', addressNormalized: '', province: '',
  city: '', district: '', orderedAtOriginal: '', orderedAtNormalized: '',
  paidAtOriginal: '', paidAtNormalized: '', productTotalCents: 0, shippingFeeCents: 0,
  amountCents: 0, platformTransactionStatus: 'paid', fulfillmentStatus: 'pending_shipment',
  items: [],
};
const unusedOcrSettings = new OcrSettingsService(
  { read: () => null, write: () => undefined },
  {
    getApiKey: async () => null,
    setApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
    getDisplayName: () => '测试系统凭据库',
  },
  { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
);

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('售后流程模板 Electron IPC', () => {
  it('只暴露受校验的流程管理与处理单调整通道', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-workflow-ipc-'));
    const session = new DesktopSession(
      new Preferences(join(testRoot, '启动配置')),
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(join(testRoot, '订单数据'));
    registerIpcHandlers(session);

    const presets = await invoke('aftersales-workflows:list') as Array<{
      id: string;
      name: string;
      origin: string;
    }>;
    expect(presets).toHaveLength(7);
    expect(presets[0]).toMatchObject({ name: '仅退款', origin: 'system' });

    const custom = await invoke('aftersales-workflows:create', {
      name: '客服协商处理',
      scenario: 'other',
      steps: [{
        id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
        fields: ['items', 'reason', 'occurred_at'], condition: null,
      }],
    }) as { id: string; version: number };
    expect(custom.version).toBe(1);
    await expect(invoke('aftersales-workflows:create', {
      name: '不安全流程', scenario: 'other', steps: [], script: 'while(true){}',
    })).rejects.toThrow(/循环、脚本|未定义/u);
    await expect(invoke('aftersales-workflows:update', presets[0].id, {
      expectedVersion: 1,
      name: '改写预置',
      scenario: 'refund_only',
      steps: [],
    })).rejects.toThrow('系统预置售后流程不能修改');

    expect(await invoke('aftersales-workflows:set-enabled', presets[0].id, false))
      .toEqual(expect.objectContaining({ id: presets[0].id, enabled: false }));
    await expect(invoke('aftersales-cases:change-workflow', {
      caseId: '', expectedRevision: 1, workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:00:00+08:00', reason: '测试',
    })).rejects.toThrow('售后处理单标识无效');
    await expect(invoke('aftersales-cases:progress', {
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 500,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '调整目标',
      extra: 1,
    })).rejects.toThrow('调整退款目标参数包含未知字段：extra');
    await expect(invoke('aftersales-cases:progress', {
      kind: 'end_refund',
      caseId: 'case-1',
      expectedRevision: 2,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '  ',
    })).rejects.toThrow('请填写 1 至 500 字的结束退款原因');
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
