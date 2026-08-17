import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试临时目录集中接管：os.tmpdir() 实时读取 TMPDIR 环境变量，
// 在工作进程启动前指到专门的测试根目录，测试再怎么建库也只落在这一处。
// 优先使用 XIANYU_TEST_TMPDIR 指定的目录（默认 DataSSD 上的用户目录；
// 卷根目录归 root 所有不可写）；磁盘不存在时（例如 CI 环境）回退系统
// 临时目录。两种情况下都按次清理，不再累积。
const TEST_TMPDIR = process.env.XIANYU_TEST_TMPDIR?.trim()
  || '/Volumes/DataSSD/SystemDiskOffload/xianyu-test-tmp';
const STALE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function resolveRunRoot(): string {
  try {
    mkdirSync(TEST_TMPDIR, { recursive: true });
    return TEST_TMPDIR;
  } catch {
    return tmpdir();
  }
}

function pruneStaleRuns(root: string): void {
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('run-')) continue;
    const path = join(root, entry);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_RUN_MAX_AGE_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // 单个残留目录清不掉不影响本次运行，交给下次再试。
    }
  }
}

export default function setup(): (() => void) | void {
  const root = resolveRunRoot();
  pruneStaleRuns(root);
  const runDirectory = mkdtempSync(join(root, 'run-'));
  process.env.TMPDIR = runDirectory;
  return () => {
    rmSync(runDirectory, { recursive: true, force: true });
  };
}
