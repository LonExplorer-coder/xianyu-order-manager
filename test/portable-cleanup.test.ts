import { describe, expect, it, vi } from 'vitest';

import {
  removeDirectoryBestEffort,
  removeDirectoryWithRetries,
} from '../scripts/portable-cleanup.mjs';

describe('便携版验证临时目录清理', () => {
  it('对 Windows 瞬时占用错误做有界重试并在释放后成功', async () => {
    let clock = 0;
    let attempts = 0;
    const wait = vi.fn(async (delayMs: number) => {
      clock += delayMs;
    });

    await expect(removeDirectoryWithRetries('C:\\portable-program', {
      label: '第一份便携程序目录',
      timeoutMs: 100,
      retryDelayMs: 10,
      now: () => clock,
      wait,
      remove: async () => {
        attempts += 1;
        if (attempts === 1) throw fsError('EPERM');
        if (attempts === 2) throw fsError('EBUSY');
      },
    })).resolves.toEqual({ attempts: 3 });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('持续占用超过截止时间时保留标签、错误码和尝试次数', async () => {
    let clock = 0;
    const wait = async (delayMs: number) => {
      clock += delayMs;
    };

    await expect(removeDirectoryWithRetries('C:\\portable-program', {
      label: '第一份便携程序目录',
      timeoutMs: 25,
      retryDelayMs: 10,
      now: () => clock,
      wait,
      remove: async () => {
        throw fsError('EPERM');
      },
    })).rejects.toThrow('第一份便携程序目录删除失败：EPERM（已尝试 4 次）');
  });

  it('非瞬时文件错误立即失败而不等待', async () => {
    const wait = vi.fn(async () => undefined);

    await expect(removeDirectoryWithRetries('C:\\portable-program', {
      label: '第一份便携程序目录',
      wait,
      remove: async () => {
        throw fsError('EACCES');
      },
    })).rejects.toThrow('第一份便携程序目录删除失败：EACCES（已尝试 1 次）');
    expect(wait).not.toHaveBeenCalled();
  });

  it('尽力清理失败只告警且不会覆盖主验证错误', async () => {
    const primary = new Error('替代程序读取失败');
    const warn = vi.fn();
    const operation = async () => {
      try {
        throw primary;
      } finally {
        await removeDirectoryBestEffort('C:\\portable-root', {
          label: '便携验证临时目录',
          timeoutMs: 0,
          warn,
          remove: async () => {
            throw fsError('EPERM');
          },
        });
      }
    };

    await expect(operation()).rejects.toBe(primary);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      '便携验证临时目录清理失败，已交由操作系统回收',
    ));
  });

  it('主验证成功时尽力清理失败返回 false 并告警', async () => {
    const warn = vi.fn();

    await expect(removeDirectoryBestEffort('C:\\portable-root', {
      label: '便携验证临时目录',
      timeoutMs: 0,
      warn,
      remove: async () => {
        throw fsError('EPERM');
      },
    })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
