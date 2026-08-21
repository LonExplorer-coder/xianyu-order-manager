import { describe, expect, it, vi } from 'vitest';

import { acquireSingleInstance } from '../src/main/single-instance';

describe('Electron 全局月度额度单实例保护', () => {
  it('未取得单实例锁时退出且不注册唤起处理', () => {
    const application = {
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
      on: vi.fn(),
    };

    expect(acquireSingleInstance(application, () => undefined)).toBe(false);
    expect(application.quit).toHaveBeenCalledOnce();
    expect(application.on).not.toHaveBeenCalled();
  });

  it('再次启动时恢复并聚焦现有窗口', () => {
    let secondInstanceHandler: (() => void) | undefined;
    const application = {
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      on: vi.fn((_event: string, handler: () => void) => {
        secondInstanceHandler = handler;
        return application;
      }),
    };
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    };

    expect(acquireSingleInstance(application, () => window)).toBe(true);
    secondInstanceHandler?.();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(application.quit).not.toHaveBeenCalled();
  });
});
