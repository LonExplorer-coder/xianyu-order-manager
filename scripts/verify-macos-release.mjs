import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_BUNDLE_ID = 'com.lonexplorer.xianyu-order-manager';
const EXPECTED_TEAM_ID = process.env.XIANYU_APPLE_TEAM_ID?.trim() || 'N45Y2W3ST3';
const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));

if (process.platform !== 'darwin') {
  throw new Error('macOS 正式发行包只能在 macOS 上验证');
}

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const EXPECTED_VERSION = packageJson.version;
const defaultZip = `out/make/zip/darwin/arm64/XianyuOrderManager-darwin-arm64-${packageJson.version}.zip`;
const targetPath = resolve(process.argv[2] ?? defaultZip);
if (!existsSync(targetPath)) throw new Error(`找不到待验证的发行物：${targetPath}`);

let temporaryDirectory = null;
let appPath = targetPath;
try {
  if (targetPath.endsWith('.zip')) {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'xianyu-release-verify-'));
    execFileSync('ditto', ['-x', '-k', targetPath, temporaryDirectory], { stdio: 'inherit' });
    appPath = join(temporaryDirectory, 'XianyuOrderManager.app');
  }
  if (!appPath.endsWith('.app') || !existsSync(appPath)) {
    throw new Error(`发行物中找不到 XianyuOrderManager.app：${basename(targetPath)}`);
  }

  verifyReleaseApplication(appPath);
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}

function verifyReleaseApplication(appPath) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], {
    stdio: 'inherit',
  });

  const bundleId = execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  if (bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error(`应用标识错误：期望 ${EXPECTED_BUNDLE_ID}，实际 ${bundleId}`);
  }
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const actualVersion = execFileSync(
      'plutil',
      ['-extract', key, 'raw', join(appPath, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim();
    if (actualVersion !== EXPECTED_VERSION) {
      throw new Error(`${key} 错误：期望 ${EXPECTED_VERSION}，实际 ${actualVersion}`);
    }
  }

  const signature = spawnSync('codesign', ['--display', '--verbose=4', appPath], {
    encoding: 'utf8',
  });
  if (signature.status !== 0) throw new Error('无法读取 macOS 应用签名');
  const signatureDetails = `${signature.stdout}${signature.stderr}`;
  if (!signatureDetails.includes('Authority=Developer ID Application:')) {
    throw new Error('应用没有使用 Developer ID Application 证书签名');
  }
  const teamId = /^TeamIdentifier=(.+)$/m.exec(signatureDetails)?.[1]?.trim();
  if (teamId !== EXPECTED_TEAM_ID) {
    throw new Error(`Apple Developer Team 不匹配：期望 ${EXPECTED_TEAM_ID}`);
  }
  if (!/^CodeDirectory .+\bruntime\b/m.test(signatureDetails)) {
    throw new Error('正式发行应用没有启用 Hardened Runtime');
  }

  const keyringBinary = join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
  );
  execFileSync('codesign', ['--verify', '--strict', '--verbose=4', keyringBinary], {
    stdio: 'inherit',
  });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], {
    stdio: 'inherit',
  });
  execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
  execFileSync(
    process.execPath,
    [join(scriptDirectory, 'run-packaged-credential-smoke.mjs'), appPath],
    { stdio: 'inherit' },
  );

  console.log(
    `最终 ZIP ${EXPECTED_VERSION} 的版本、Developer ID 签名、公证、Gatekeeper 和凭据库校验全部通过。`,
  );
}
