import { MakerZIP } from '@electron-forge/maker-zip';
import AutoUnpackNativesPlugin from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';

const MAC_RELEASE_BUILD = process.env.XIANYU_MAC_RELEASE === '1';
const MAC_NOTARY_KEYCHAIN_PROFILE =
  process.env.XIANYU_NOTARY_KEYCHAIN_PROFILE?.trim() || 'xianyu-order-manager-notary';
type MacSignOptions = Exclude<
  NonNullable<NonNullable<ForgeConfig['packagerConfig']>['osxSign']>,
  true
>;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'XianyuOrderManager',
    executableName: 'XianyuOrderManager',
    appBundleId: 'com.lonexplorer.xianyu-order-manager',
    ...macSecurityOptions(),
    afterPrune: [
      (buildPath, _electronVersion, platform, arch, callback) => {
        try {
          copyKeyringRuntime(buildPath, platform, arch);
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error('无法复制系统凭据运行库'));
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin', 'win32'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/electron-main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/electron-preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

function macSecurityOptions(): Pick<
  NonNullable<ForgeConfig['packagerConfig']>,
  'osxSign' | 'osxNotarize'
> | Record<string, never> {
  if (process.platform !== 'darwin') return {};
  if (MAC_RELEASE_BUILD) {
    return {
      osxSign: failClosedMacSign({}),
      osxNotarize: { keychainProfile: MAC_NOTARY_KEYCHAIN_PROFILE },
    };
  }
  return {
    osxSign: failClosedMacSign({
      identity: '-',
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    }),
  };
}

function failClosedMacSign(options: MacSignOptions): MacSignOptions {
  // Electron Packager 19 supports this at runtime but omits it from the macOS option type.
  return { ...options, continueOnError: false } as MacSignOptions;
}

function copyKeyringRuntime(buildPath: string, platform: string, arch: string): void {
  const platformPackage = keyringPlatformPackage(platform, arch);
  const sourceRoot = join(process.cwd(), 'node_modules', '@napi-rs');
  const destinationRoot = join(buildPath, 'node_modules', '@napi-rs');
  mkdirSync(destinationRoot, { recursive: true });
  for (const packageName of ['keyring', platformPackage]) {
    cpSync(join(sourceRoot, packageName), join(destinationRoot, packageName), {
      recursive: true,
      dereference: true,
    });
  }
}

function keyringPlatformPackage(platform: string, arch: string): string {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `keyring-darwin-${arch}`;
  }
  if (platform === 'win32' && ['arm64', 'x64', 'ia32'].includes(arch)) {
    return `keyring-win32-${arch}-msvc`;
  }
  throw new Error(`系统凭据运行库不支持目标平台 ${platform}-${arch}`);
}

export default config;
