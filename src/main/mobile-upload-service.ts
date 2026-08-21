import Busboy from 'busboy';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import QRCode from 'qrcode';

import type { RecognitionBatchView } from '../core/contracts';
import {
  MOBILE_UPLOAD_MAX_FILE_BYTES,
  MOBILE_UPLOAD_MAX_FILES,
  MOBILE_UPLOAD_SESSION_DURATION_MS,
  type MobileUploadSessionView,
  type MobileUploadStatus,
} from '../core/mobile-upload';

const SUPPORTED_IMAGES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const COOKIE_NAME = 'xianyu_mobile_upload';
const MAX_AUTHORIZATION_BODY_BYTES = 1_024;
const MAX_MULTIPART_BODY_BYTES = (
  MOBILE_UPLOAD_MAX_FILES * MOBILE_UPLOAD_MAX_FILE_BYTES
) + (2 * 1024 * 1024);

type SubmitSourceScreenshots = (paths: string[]) => Promise<RecognitionBatchView>;

interface MobileUploadServiceOptions {
  submitSourceScreenshots: SubmitSourceScreenshots;
  selectHost?: () => string;
  createSecret?: (length: number, alphabet?: string) => string;
  createQrDataUrl?: (url: string) => Promise<string>;
  now?: () => Date;
  sessionDurationMs?: number;
}

interface ActiveMobileUploadSession {
  server: Server;
  token: string;
  accessCode: string;
  browserToken: string;
  expiresAtMs: number;
  view: MobileUploadSessionView;
  expiryTimer: NodeJS.Timeout;
}

export class MobileUploadService {
  private readonly submitSourceScreenshots: SubmitSourceScreenshots;
  private readonly selectHost: () => string;
  private readonly createSecret: (length: number, alphabet?: string) => string;
  private readonly createQrDataUrl: (url: string) => Promise<string>;
  private readonly now: () => Date;
  private readonly sessionDurationMs: number;
  private active: ActiveMobileUploadSession | null = null;

  public constructor(options: MobileUploadServiceOptions) {
    this.submitSourceScreenshots = options.submitSourceScreenshots;
    this.selectHost = options.selectHost ?? selectPrivateIpv4Address;
    this.createSecret = options.createSecret ?? secureRandomText;
    this.createQrDataUrl = options.createQrDataUrl ?? ((url) => QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
    }));
    this.now = options.now ?? (() => new Date());
    this.sessionDurationMs = options.sessionDurationMs ?? MOBILE_UPLOAD_SESSION_DURATION_MS;
  }

  public async start(): Promise<MobileUploadSessionView> {
    if (this.active && !this.isExpired(this.active)) return { ...this.active.view };
    if (this.active) await this.stop();

    const host = this.selectHost();
    const token = this.createSecret(48);
    const accessCode = this.createSecret(6, '0123456789');
    const browserToken = this.createSecret(32);
    const expiresAtMs = this.now().getTime() + this.sessionDurationMs;
    const server = createServer({
      requestTimeout: 60_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 2_000,
      maxHeaderSize: 16 * 1024,
    }, (request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = error instanceof MobileUploadHttpError ? error.status : 500;
        this.sendText(
          response,
          status,
          error instanceof MobileUploadHttpError
            ? error.message
            : '手机上传失败，请回到桌面端重试',
        );
      });
    });
    server.maxRequestsPerSocket = 20;

    await listen(server, host);
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('无法确定手机上传地址');
    }
    const url = `http://${host}:${address.port}/?session=${encodeURIComponent(token)}`;
    let qrDataUrl: string;
    try {
      qrDataUrl = await this.createQrDataUrl(url);
    } catch {
      server.close();
      throw new Error('无法生成手机上传二维码');
    }
    const view: MobileUploadSessionView = {
      enabled: true,
      url,
      qrDataUrl,
      accessCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const expiryTimer = setTimeout(() => {
      void this.stop();
    }, Math.max(0, expiresAtMs - this.now().getTime()));
    expiryTimer.unref();
    this.active = {
      server,
      token,
      accessCode,
      browserToken,
      expiresAtMs,
      view,
      expiryTimer,
    };
    return { ...view };
  }

  public getStatus(): MobileUploadStatus {
    if (!this.active) return { enabled: false };
    if (this.isExpired(this.active)) {
      void this.stop();
      return { enabled: false };
    }
    return { ...this.active.view };
  }

  public async stop(): Promise<void> {
    const current = this.active;
    this.active = null;
    if (!current) return;
    clearTimeout(current.expiryTimer);
    current.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      current.server.close(() => resolve());
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const current = this.active;
    if (!current) {
      this.sendNotFound(response);
      return;
    }
    if (this.isExpired(current)) {
      this.sendText(response, 410, '手机上传会话已过期，请回到桌面端重新开启');
      await this.stop();
      return;
    }
    if (!isLocalNetworkClient(request.socket.remoteAddress)) {
      this.sendNotFound(response);
      return;
    }

    const requestUrl = new URL(request.url ?? '/', current.view.url);
    if (request.method === 'GET' && requestUrl.pathname === '/') {
      if (!safeSecretEquals(requestUrl.searchParams.get('session'), current.token)) {
        this.sendNotFound(response);
        return;
      }
      this.sendHtml(response, 200, authorizationPage(current.token));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/authorize') {
      await this.authorize(request, response, current);
      return;
    }
    if (requestUrl.pathname === '/upload') {
      if (!this.hasBrowserAuthorization(request, current)) {
        this.sendText(response, 401, '请先输入桌面端显示的临时访问码');
        return;
      }
      if (request.method === 'GET') {
        this.sendHtml(response, 200, uploadPage(current.expiresAtMs));
        return;
      }
      if (request.method === 'POST') {
        await this.receiveUpload(request, response);
        return;
      }
    }
    if (['GET', 'POST'].includes(request.method ?? '')) {
      this.sendNotFound(response);
      return;
    }
    response.setHeader('Allow', 'GET, POST');
    this.sendText(response, 405, '不支持此请求方式');
  }

  private async authorize(
    request: IncomingMessage,
    response: ServerResponse,
    current: ActiveMobileUploadSession,
  ): Promise<void> {
    if (!contentType(request).startsWith('application/x-www-form-urlencoded')) {
      throw new MobileUploadHttpError(415, '临时访问码提交格式无效');
    }
    const body = new URLSearchParams(await readLimitedText(request, MAX_AUTHORIZATION_BODY_BYTES));
    if (
      !safeSecretEquals(body.get('session'), current.token)
      || !safeSecretEquals(body.get('accessCode'), current.accessCode)
    ) {
      this.sendText(response, 401, '临时访问码无效或已过期');
      return;
    }
    const maxAgeSeconds = Math.max(0, Math.floor((current.expiresAtMs - this.now().getTime()) / 1000));
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(current.browserToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`,
    );
    response.statusCode = 303;
    response.setHeader('Location', '/upload');
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  private async receiveUpload(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!contentType(request).startsWith('multipart/form-data')) {
      throw new MobileUploadHttpError(415, '请选择来源截图后再上传');
    }
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
      throw new MobileUploadHttpError(413, '本次上传内容过大，请减少来源截图后重试');
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'xianyu-mobile-upload-'));
    try {
      const paths = await parseMultipartImages(request, temporaryDirectory);
      if (paths.length === 0) throw new MobileUploadHttpError(400, '请至少选择 1 张来源截图');
      const batch = await this.submitSourceScreenshots(paths);
      this.sendHtml(response, 201, uploadSuccessPage(batch));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private hasBrowserAuthorization(
    request: IncomingMessage,
    current: ActiveMobileUploadSession,
  ): boolean {
    const cookies = parseCookies(request.headers.cookie);
    return safeSecretEquals(cookies.get(COOKIE_NAME), current.browserToken);
  }

  private isExpired(current: ActiveMobileUploadSession): boolean {
    return this.now().getTime() >= current.expiresAtMs;
  }

  private sendHtml(response: ServerResponse, status: number, body: string): void {
    applySecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(body);
  }

  private sendText(response: ServerResponse, status: number, body: string): void {
    applySecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(body);
  }

  private sendNotFound(response: ServerResponse): void {
    this.sendText(response, 404, '页面不存在');
  }
}

export function selectPrivateIpv4Address(): string {
  const candidates = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map((entry) => entry.address)
    .sort((left, right) => privateAddressPriority(left) - privateAddressPriority(right));
  if (candidates.length === 0) {
    throw new Error('未找到可用的局域网 IPv4 地址，请先连接与手机相同的 Wi-Fi');
  }
  return candidates[0];
}

function secureRandomText(length: number, alphabet?: string): string {
  if (!alphabet) return randomBytes(Math.ceil(length * 0.75)).toString('base64url').slice(0, length);
  const bytes = randomBytes(length);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

async function parseMultipartImages(
  request: IncomingMessage,
  temporaryDirectory: string,
): Promise<string[]> {
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      preservePath: false,
      defParamCharset: 'utf8',
      limits: {
        fileSize: MOBILE_UPLOAD_MAX_FILE_BYTES,
        files: MOBILE_UPLOAD_MAX_FILES,
        fields: 0,
        parts: MOBILE_UPLOAD_MAX_FILES,
        headerPairs: 100,
      },
    });
  } catch {
    throw new MobileUploadHttpError(400, '无法读取上传内容，请重新选择来源截图');
  }

  const paths: string[] = [];
  const writes: Promise<void>[] = [];
  let failure: MobileUploadHttpError | null = null;
  let fileCount = 0;
  parser.on('file', (fieldName, file, info) => {
    fileCount += 1;
    const safeName = safeUploadFileName(info.filename, fileCount);
    const expectedMime = SUPPORTED_IMAGES.get(extname(safeName).toLowerCase());
    if (fieldName !== 'screenshots' || !expectedMime || expectedMime !== info.mimeType) {
      failure ??= new MobileUploadHttpError(
        400,
        '当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图',
      );
      file.resume();
      return;
    }
    const itemDirectory = join(temporaryDirectory, String(fileCount));
    const destination = join(itemDirectory, safeName);
    const write = mkdir(itemDirectory, { recursive: true })
      .then(() => pipeline(file, createWriteStream(destination, { flags: 'wx' })))
      .then(async () => {
        if (file.truncated || (await stat(destination)).size > MOBILE_UPLOAD_MAX_FILE_BYTES) {
          failure ??= new MobileUploadHttpError(
            413,
            '单张来源截图不能超过 7.5 MB，请压缩后重试',
          );
          return;
        }
        paths.push(destination);
      });
    writes.push(write);
  });
  parser.once('filesLimit', () => {
    failure ??= new MobileUploadHttpError(413, '一次最多上传 50 张来源截图');
  });
  parser.once('partsLimit', () => {
    if (fileCount >= MOBILE_UPLOAD_MAX_FILES) {
      failure ??= new MobileUploadHttpError(413, '一次最多上传 50 张来源截图');
    }
  });

  await new Promise<void>((resolve, reject) => {
    parser.once('close', resolve);
    parser.once('error', () => reject(
      new MobileUploadHttpError(400, '无法读取上传内容，请重新选择来源截图'),
    ));
    request.once('aborted', () => reject(
      new MobileUploadHttpError(400, '手机上传已中断，请重试'),
    ));
    request.pipe(parser);
  });
  await Promise.all(writes);
  if (failure) throw failure;
  return paths.sort();
}

function safeUploadFileName(filename: string, index: number): string {
  const normalized = basename(filename.replaceAll('\\', '/'))
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();
  if (!normalized) return `来源截图-${index}.png`;
  return normalized.slice(-180);
}

async function readLimitedText(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new MobileUploadHttpError(413, '临时访问码请求过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function contentType(request: IncomingMessage): string {
  return String(request.headers['content-type'] ?? '').toLowerCase();
}

function parseCookies(value: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of value?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(rawValue));
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
}

function safeSecretEquals(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== 'string') return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function isLocalNetworkClient(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '127.0.0.1' || normalized === '::1' || isPrivateIpv4(normalized);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function privateAddressPriority(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  return 2;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f3f2ed;color:#20211f;font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}section{background:#fff;border:1px solid #d9d7cf;border-radius:18px;padding:1.5rem}h1{font-size:1.65rem;margin:.1rem 0 .5rem}p{color:#5d5e58}label{display:block;font-weight:650;margin:1.25rem 0 .4rem}input{box-sizing:border-box;width:100%;font:inherit;padding:.85rem;border:1px solid #a9aaa4;border-radius:10px}button{width:100%;margin-top:1rem;padding:.9rem;border:0;border-radius:10px;background:#f5b800;color:#171713;font:700 1rem system-ui}small{display:block;color:#777970;margin-top:1rem}.error{color:#9d241a}
</style></head><body><main><section>${body}</section></main></body></html>`;
}

function authorizationPage(token: string): string {
  return page('手机上传授权', `<h1>连接闲鱼订单管理</h1>
<p>输入桌面端显示的临时访问码。授权只在本次手机上传会话内有效。</p>
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="session" value="${escapeHtml(token)}">
<label for="accessCode">临时访问码</label>
<input id="accessCode" name="accessCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus>
<button type="submit">继续上传</button></form>
<small>此页面只能上传来源截图，不能查看、编辑或导出订单。</small>`);
}

function uploadPage(expiresAtMs: number): string {
  return page('上传来源截图', `<h1>上传来源截图</h1>
<p>选择 1–50 张包含完整闲鱼订单详情的 PNG、JPG、JPEG 或 WebP 图片；单张不超过 7.5 MB。</p>
<form method="post" action="/upload" enctype="multipart/form-data">
<label for="screenshots">来源截图</label>
<input id="screenshots" name="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple required>
<button type="submit">创建识别批次</button></form>
<small>本次手机上传会话将在 ${escapeHtml(new Date(expiresAtMs).toLocaleTimeString('zh-CN'))} 前失效。</small>`);
}

function uploadSuccessPage(batch: RecognitionBatchView): string {
  return page('上传完成', `<h1>已创建识别批次</h1>
<p>已接收 ${batch.items.length} 张来源截图。桌面端会继续显示识别、待确认与失败进度。</p>
<form method="get" action="/upload"><button type="submit">继续上传</button></form>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

class MobileUploadHttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}
