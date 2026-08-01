import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const MAX_SCREENSHOT_BYTES = 7_500_000;
const MINIMUM_CASES = 30;
const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

void main().catch(() => {
  process.stderr.write(
    '第一阶段私有验收未完成；未输出任何订单值或私有路径。\n',
  );
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.confirmPaidServices) {
    throw new Error('未明确确认付费识别服务');
  }

  const manifestPath = resolve(options.manifest);
  const preflight = preflightManifest(manifestPath);
  assertCleanGit(repositoryRoot);

  const sourceConfigDirectory = resolve(
    options.configDirectory ?? deriveDefaultConfigDirectory(),
  );
  const configuredServices = assertConfigurationAvailable(sourceConfigDirectory);

  const manifestDirectory = dirname(realpathSync(manifestPath));
  const runsDirectory = join(manifestDirectory, 'runs');
  mkdirSync(runsDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDataPath(runsDirectory);
  const runDirectory = join(
    runsDirectory,
    `${compactUtcTimestamp()}-${randomUUID()}`,
  );
  mkdirSync(runDirectory, { mode: 0o700 });
  assertPrivateDataPath(runDirectory);

  process.stdout.write(
    `已完成 ${preflight.manifest.cases.length} 个样本的本地预检；本次将调用${configuredServices.join('、')}。\n`,
  );
  const status = await runCaptureTest({
    manifestPath,
    expectedManifestSha256: preflight.manifestSha256,
    runDirectory,
    sourceConfigDirectory,
  });
  if (status !== 0) throw new Error('私有验收测试失败');
  process.stdout.write(
    '第一阶段私有验收完成；私有现场与公开汇总报告已分开保存。\n',
  );
}

function parseArguments(argumentsList) {
  const normalizedArguments = argumentsList[0] === '--'
    ? argumentsList.slice(1)
    : argumentsList;
  let manifest;
  let configDirectory;
  let confirmPaidServices = false;
  for (let index = 0; index < normalizedArguments.length; index += 1) {
    const argument = normalizedArguments[index];
    if (argument === '--confirm-paid-services') {
      confirmPaidServices = true;
      continue;
    }
    if (argument === '--manifest' || argument === '--config-dir') {
      const value = normalizedArguments[index + 1];
      if (!value || value.startsWith('--')) throw new Error('参数缺少值');
      if (argument === '--manifest') manifest = value;
      else configDirectory = value;
      index += 1;
      continue;
    }
    throw new Error('存在不支持的参数');
  }
  if (!manifest) throw new Error('缺少私有金标清单');
  return { manifest, configDirectory, confirmPaidServices };
}

function preflightManifest(manifestPath) {
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('私有金标清单不可用');
  }
  assertPrivateIgnoredFile(manifestPath);
  assertPrivateDataPath(manifestPath);
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('私有金标清单无法解析');
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.cases)) {
    throw new Error('私有金标清单格式无效');
  }
  if (manifest.cases.length < MINIMUM_CASES) {
    throw new Error('私有金标样本数不足');
  }

  const manifestDirectory = dirname(realpathSync(manifestPath));
  const fingerprints = new Set();
  for (const testCase of manifest.cases) {
    if (
      !testCase ||
      typeof testCase !== 'object' ||
      typeof testCase.screenshot !== 'string' ||
      typeof testCase.screenshotSha256 !== 'string'
    ) {
      throw new Error('私有金标案例格式无效');
    }
    const screenshotPath = resolvePrivateScreenshot(
      manifestDirectory,
      testCase.screenshot,
    );
    assertPrivateIgnoredFile(screenshotPath);
    const screenshotStat = statSync(screenshotPath);
    if (!screenshotStat.isFile()) throw new Error('私有截图不是文件');
    if (!SCREENSHOT_EXTENSIONS.has(extname(screenshotPath).toLowerCase())) {
      throw new Error('私有截图类型不受支持');
    }
    if (screenshotStat.size > MAX_SCREENSHOT_BYTES) {
      throw new Error('私有截图超过 7.5 MB');
    }
    const screenshotBytes = readFileSync(screenshotPath);
    if (!hasExpectedImageSignature(screenshotBytes, extname(screenshotPath))) {
      throw new Error('私有截图内容与文件类型不一致');
    }
    const expectedHash = testCase.screenshotSha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error('私有截图指纹格式无效');
    }
    const actualHash = createHash('sha256')
      .update(screenshotBytes)
      .digest('hex');
    if (actualHash !== expectedHash) throw new Error('私有截图指纹不一致');
    fingerprints.add(expectedHash);
  }
  if (fingerprints.size < MINIMUM_CASES) {
    throw new Error('私有金标不同截图数不足');
  }
  return {
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
}

function assertPrivateIgnoredFile(inputPath) {
  const repositoryRelationship = relative(realpathSync(repositoryRoot), realpathSync(inputPath));
  if (
    !repositoryRelationship ||
    isAbsolute(repositoryRelationship) ||
    repositoryRelationship === '..' ||
    repositoryRelationship.startsWith(`..${separator()}`)
  ) {
    throw new Error('私有验收输入必须位于仓库的 Git 忽略目录中');
  }
  const tracked = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', repositoryRelationship],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  const ignored = spawnSync(
    'git',
    ['check-ignore', '-q', '--', repositoryRelationship],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  if (tracked.error || ignored.error || tracked.status === 0 || ignored.status !== 0) {
    throw new Error('私有验收输入必须未被 Git 跟踪且已由 .gitignore 排除');
  }
}

function assertPrivateDataPath(inputPath) {
  const privateDataRoot = resolve(repositoryRoot, 'private-data');
  const relationship = relative(privateDataRoot, realpathSync(inputPath));
  if (
    !relationship ||
    isAbsolute(relationship) ||
    relationship === '..' ||
    relationship.startsWith(`..${separator()}`)
  ) {
    throw new Error('私有验收输入必须位于仓库 private-data 目录中');
  }
}

function hasExpectedImageSignature(bytes, extension) {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === '.png') {
    return bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (normalizedExtension === '.jpg' || normalizedExtension === '.jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (normalizedExtension === '.webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function resolvePrivateScreenshot(manifestDirectory, screenshot) {
  if (isAbsolute(screenshot) || /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(screenshot)) {
    throw new Error('截图必须使用相对路径');
  }
  const segments = screenshot.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === '..' || segment === '.')) {
    throw new Error('截图相对路径不安全');
  }
  const screenshotPath = realpathSync(join(manifestDirectory, ...segments));
  const relationship = relative(manifestDirectory, screenshotPath);
  if (!relationship || relationship.startsWith(`..${separator()}`) || isAbsolute(relationship)) {
    throw new Error('截图必须位于清单目录内');
  }
  return screenshotPath;
}

function separator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function assertCleanGit(cwd) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (status.trim()) throw new Error('付费验收前 Git 必须干净');
}

function assertConfigurationAvailable(configDirectory) {
  const required = join(configDirectory, 'ocr-settings.json');
  if (!existsSync(required) || !statSync(required).isFile()) {
    throw new Error('未找到已保存的 OCR 设置');
  }
  const optional = join(configDirectory, 'candidate-verification-settings.json');
  if (existsSync(optional) && !statSync(optional).isFile()) {
    throw new Error('候选裁决设置不是文件');
  }
  let candidateService;
  if (existsSync(optional)) {
    try {
      const settings = JSON.parse(readFileSync(optional, 'utf8'));
      if (settings?.enabled === true) {
        const providerLabels = {
          deepseek: '已配置的 DeepSeek 候选裁决服务',
          'aliyun-bailian': '已配置的百炼候选裁决服务',
          'openai-compatible': '已配置的 OpenAI 兼容候选裁决服务',
        };
        candidateService = providerLabels[settings.provider];
        if (!candidateService) throw new Error('候选裁决服务商无效');
      }
    } catch {
      throw new Error('候选裁决设置无法解析');
    }
  }
  return [
    '百炼 OCR 服务',
    ...(candidateService ? [candidateService] : []),
  ];
}

function deriveDefaultConfigDirectory() {
  const productDirectory = '闲鱼订单管理';
  if (process.platform === 'darwin') {
    const home = homedir();
    if (!home || !isAbsolute(home)) throw new Error('无法安全推导配置目录');
    return join(home, 'Library', 'Application Support', productDirectory, 'bootstrap');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (!appData || !isAbsolute(appData)) throw new Error('无法安全推导配置目录');
    return join(appData, productDirectory, 'bootstrap');
  }
  const home = homedir();
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || (
    home && isAbsolute(home) ? join(home, '.config') : ''
  );
  if (!configRoot || !isAbsolute(configRoot)) {
    throw new Error('无法安全推导配置目录');
  }
  return join(configRoot, productDirectory, 'bootstrap');
}

function compactUtcTimestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function runCaptureTest({
  manifestPath,
  expectedManifestSha256,
  runDirectory,
  sourceConfigDirectory,
}) {
  const vitestEntry = join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestEntry)) throw new Error('未安装 Vitest');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        vitestEntry,
        'run',
        'test/private-stage-one-capture.test.ts',
        '--reporter=dot',
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          XIANYU_PRIVATE_STAGE_ONE_CAPTURE: '1',
          XIANYU_PRIVATE_STAGE_ONE_CONFIRM_PAID_SERVICES: '1',
          XIANYU_PRIVATE_STAGE_ONE_MANIFEST: manifestPath,
          XIANYU_PRIVATE_STAGE_ONE_EXPECTED_MANIFEST_SHA256: expectedManifestSha256,
          XIANYU_PRIVATE_STAGE_ONE_RUN_DIRECTORY: runDirectory,
          XIANYU_PRIVATE_STAGE_ONE_SOURCE_CONFIG: sourceConfigDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Never forward child output: failed OCR responses, assertion values and
    // private paths must not escape to the terminal.
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise(code ?? 1));
  });
}
