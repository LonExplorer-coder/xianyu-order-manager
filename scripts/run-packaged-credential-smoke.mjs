import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const targetPath = resolve(process.argv[2] ?? defaultTargetPath());
const executable = packagedExecutable(targetPath);
if (!existsSync(executable)) throw new Error(`找不到打包后的应用：${targetPath}`);

const result = spawnSync(executable, [], {
  encoding: 'utf8',
  env: { ...process.env, XIANYU_PACKAGED_CREDENTIAL_SMOKE: '1' },
  timeout: 30_000,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  const timeout = result.error.code === 'ETIMEDOUT' ? '（30 秒超时）' : '';
  throw new Error(`打包后凭据测试无法完成${timeout}: ${result.error.message}`);
}
if (result.status !== 0) {
  throw new Error(`打包后凭据测试失败，退出码：${String(result.status)}`);
}

function defaultTargetPath() {
  if (process.platform === 'darwin') {
    return 'out/XianyuOrderManager-darwin-arm64/XianyuOrderManager.app';
  }
  if (process.platform === 'win32') {
    return 'out/XianyuOrderManager-win32-x64/XianyuOrderManager.exe';
  }
  throw new Error('打包后凭据测试仅支持 macOS 和 Windows 应用');
}

function packagedExecutable(targetPath) {
  if (process.platform === 'darwin') {
    return resolve(targetPath, 'Contents/MacOS/XianyuOrderManager');
  }
  if (process.platform === 'win32') return targetPath;
  throw new Error('打包后凭据测试仅支持 macOS 和 Windows 应用');
}
