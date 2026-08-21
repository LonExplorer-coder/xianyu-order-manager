import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileUploadService } from '../src/main/mobile-upload-service';

const services: MobileUploadService[] = [];
const storageRoots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(storageRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('手机上传会话', () => {
  it('只有二维码令牌与临时访问码共同有效时才允许把来源截图送入现有识别批次', async () => {
    const received: Array<Array<{ name: string; content: string }>> = [];
    const submitSourceScreenshots = vi.fn(async (paths: string[]) => {
      received.push(await Promise.all(paths.map(async (path) => ({
        name: path.split('/').at(-1) ?? '',
        content: await readFile(path, 'utf8'),
      }))));
      return {
        id: 'mobile-batch-1',
        items: paths.map((path, index) => ({
          id: `item-${index + 1}`,
          batchId: 'mobile-batch-1',
          sourceName: path.split('/').at(-1) ?? '',
          status: 'waiting_recognition' as const,
          retryCount: 0,
        })),
        totalCount: paths.length,
        processedCount: 0,
        counts: {
          waiting_recognition: paths.length,
          recognizing: 0,
          validating: 0,
          awaiting_confirmation: 0,
          imported: 0,
          waiting_retry: 0,
          failed: 0,
          duplicate_skipped: 0,
          cancelled: 0,
        },
        createdAt: '2026-08-21T08:00:00.000Z',
      };
    });
    const service = new MobileUploadService({
      submitSourceScreenshots,
      getStagingRootDirectory: await stagingRoot(),
      selectHost: () => '127.0.0.1',
      createSecret: deterministicSecrets(
        '0123456789abcdef0123456789abcdef0123456789abcdef',
        '482913',
        'authorized-browser-token',
      ),
      createQrDataUrl: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
      now: () => new Date('2026-08-21T08:00:00.000Z'),
    });
    services.push(service);

    const session = await service.start();

    expect(session).toMatchObject({
      enabled: true,
      accessCode: '482913',
      expiresAt: '2026-08-21T08:10:00.000Z',
    });
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?session=/u);
    expect(session.qrDataUrl).toMatch(/^data:image\/png;base64,/u);

    const invalidToken = await fetch(session.url.replace(/session=[^&]+/u, 'session=wrong'));
    expect(invalidToken.status).toBe(404);

    const codePage = await fetch(session.url);
    expect(codePage.status).toBe(200);
    expect(await codePage.text()).toContain('输入桌面端显示的临时访问码');

    const wrongCode = await fetch(new URL('/authorize', session.url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session: new URL(session.url).searchParams.get('session') ?? '',
        accessCode: '000000',
      }),
      redirect: 'manual',
    });
    expect(wrongCode.status).toBe(401);

    const authorization = await fetch(new URL('/authorize', session.url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session: new URL(session.url).searchParams.get('session') ?? '',
        accessCode: session.accessCode,
      }),
      redirect: 'manual',
    });
    expect(authorization.status).toBe(303);
    const cookie = authorization.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toContain('xianyu_mobile_upload=');

    const uploadPage = await fetch(new URL('/upload', session.url), {
      headers: { cookie },
    });
    const uploadHtml = await uploadPage.text();
    expect(uploadPage.status).toBe(200);
    expect(uploadHtml).toContain('上传来源截图');
    expect(uploadHtml).not.toContain('订单列表');
    expect(uploadHtml).not.toContain('导出');

    const form = new FormData();
    form.append('screenshots', new Blob(['first-image'], { type: 'image/png' }), '订单一.png');
    form.append('screenshots', new Blob(['second-image'], { type: 'image/jpeg' }), '订单二.jpg');
    const uploaded = await fetch(new URL('/upload', session.url), {
      method: 'POST',
      headers: { cookie },
      body: form,
    });

    expect(uploaded.status).toBe(201);
    expect(await uploaded.text()).toContain('已创建识别批次');
    expect(submitSourceScreenshots).toHaveBeenCalledTimes(1);
    expect(received).toEqual([[
      { name: '订单一.png', content: 'first-image' },
      { name: '订单二.jpg', content: 'second-image' },
    ]]);
  });

  it('关闭、到期或未授权后立即拒绝访问且不接收来源截图', async () => {
    let now = new Date('2026-08-21T08:00:00.000Z');
    const submitSourceScreenshots = vi.fn();
    const service = new MobileUploadService({
      submitSourceScreenshots,
      getStagingRootDirectory: await stagingRoot(),
      selectHost: () => '127.0.0.1',
      createSecret: deterministicSecrets(
        'abcdef0123456789abcdef0123456789abcdef0123456789',
        '135790',
        'authorized-browser-token',
      ),
      createQrDataUrl: async () => 'data:image/png;base64,cXI=',
      now: () => now,
    });
    services.push(service);
    const session = await service.start();

    const form = new FormData();
    form.append('screenshots', new Blob(['image'], { type: 'image/png' }), '订单.png');
    const unauthorized = await fetch(new URL('/upload', session.url), {
      method: 'POST',
      body: form,
    });
    expect(unauthorized.status).toBe(401);
    expect(submitSourceScreenshots).not.toHaveBeenCalled();

    now = new Date('2026-08-21T08:10:01.000Z');
    const expired = await fetch(session.url);
    expect(expired.status).toBe(404);
    expect(service.getStatus()).toEqual({ enabled: false });

    const restarted = await service.start();
    await service.stop();
    expect(service.getStatus()).toEqual({ enabled: false });
    await expect(fetch(restarted.url)).rejects.toThrow();
  });

  it('拒绝非图片、单文件超过 7.5 MB 或超过 50 张的请求', async () => {
    const submitSourceScreenshots = vi.fn();
    const service = new MobileUploadService({
      submitSourceScreenshots,
      getStagingRootDirectory: await stagingRoot(),
      selectHost: () => '127.0.0.1',
      createSecret: deterministicSecrets(
        'fedcba9876543210fedcba9876543210fedcba9876543210',
        '246802',
        'authorized-browser-token',
      ),
      createQrDataUrl: async () => 'data:image/png;base64,cXI=',
      now: () => new Date('2026-08-21T08:00:00.000Z'),
    });
    services.push(service);
    const session = await service.start();
    const cookie = await authorize(session.url, session.accessCode);

    const unsupported = new FormData();
    unsupported.append('screenshots', new Blob(['text'], { type: 'text/plain' }), '订单.txt');
    expect((await fetch(new URL('/upload', session.url), {
      method: 'POST', headers: { cookie }, body: unsupported,
    })).status).toBe(400);

    const oversized = new FormData();
    oversized.append(
      'screenshots',
      new Blob([new Uint8Array(7_500_001)], { type: 'image/png' }),
      '过大.png',
    );
    expect((await fetch(new URL('/upload', session.url), {
      method: 'POST', headers: { cookie }, body: oversized,
    })).status).toBe(413);

    const tooMany = new FormData();
    for (let index = 0; index < 51; index += 1) {
      tooMany.append(
        'screenshots',
        new Blob([String(index)], { type: 'image/png' }),
        `订单-${index + 1}.png`,
      );
    }
    expect((await fetch(new URL('/upload', session.url), {
      method: 'POST', headers: { cookie }, body: tooMany,
    })).status).toBe(413);
    expect(submitSourceScreenshots).not.toHaveBeenCalled();
  });

  it('请求解析期间会话到期时不再把暂存文件送入识别批次', async () => {
    let now = new Date('2026-08-21T08:00:00.000Z');
    const submitSourceScreenshots = vi.fn();
    const service = new MobileUploadService({
      submitSourceScreenshots,
      getStagingRootDirectory: await stagingRoot(),
      selectHost: () => '127.0.0.1',
      createSecret: deterministicSecrets(
        '00112233445566778899aabbccddeeff0011223344556677',
        '112233',
        'authorized-browser-token',
      ),
      createQrDataUrl: async () => 'data:image/png;base64,cXI=',
      now: () => now,
    });
    services.push(service);
    const session = await service.start();
    const cookie = await authorize(session.url, session.accessCode);
    const target = new URL('/upload', session.url);
    const boundary = 'xianyu-mobile-upload-boundary';
    const responseStatus = new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          cookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="screenshots"; filename="订单.png"\r\nContent-Type: image/png\r\n\r\nimage`,
      );
      setTimeout(() => {
        now = new Date('2026-08-21T08:10:01.000Z');
        request.end(`\r\n--${boundary}--\r\n`);
      }, 20);
    });

    expect(await responseStatus).toBe(401);
    expect(submitSourceScreenshots).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ enabled: false });
  });
});

async function authorize(url: string, accessCode: string): Promise<string> {
  const response = await fetch(new URL('/authorize', url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      session: new URL(url).searchParams.get('session') ?? '',
      accessCode,
    }),
    redirect: 'manual',
  });
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

function deterministicSecrets(...values: string[]): (length: number, alphabet?: string) => string {
  const queue = [...values];
  return () => queue.shift() ?? 'fallback-secret';
}

async function stagingRoot(): Promise<() => string> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-mobile-upload-test-'));
  storageRoots.push(root);
  return () => join(root, '.mobile-upload-staging');
}
