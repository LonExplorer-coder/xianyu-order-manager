import { normalizeBailianWorkspaceId } from '../../core/ocr-settings';
import type {
  BailianConnectionTester,
  BailianRegion,
} from '../../main/ocr-settings';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CONNECTION_TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAKUlEQVR4nO3OIQEAAAACIP+f1hkWWEB6FgEBAQEBAQEBAQEBAQEBgXdgl/rw4unIZ5cAAAAASUVORK5CYII=';

type BailianOcrClientOptions = {
  timeoutMilliseconds?: number;
  maxResponseBytes?: number;
};

export class BailianOcrClient implements BailianConnectionTester {
  private readonly timeoutMilliseconds: number;
  private readonly maxResponseBytes: number;

  public constructor(
    private readonly request: FetchLike = globalThis.fetch,
    options: BailianOcrClientOptions = {},
  ) {
    this.timeoutMilliseconds = Math.max(1, options.timeoutMilliseconds ?? 20_000);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? 1_048_576);
  }

  public async testConnection(input: {
    workspaceId: string;
    region: BailianRegion;
    apiKey: string;
  }): Promise<{ model: 'qwen3.5-ocr' }> {
    const endpoint = endpointFor(input.workspaceId, input.region);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3.5-ocr',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: CONNECTION_TEST_IMAGE },
                  min_pixels: 32 * 32 * 3,
                  max_pixels: 32 * 32 * 8192,
                },
                {
                  type: 'text',
                  text: '这是连接测试图片。请只返回你看到的文字，不要补充说明。',
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new Error('无法连接百炼服务，请检查网络后重试');
    }

    try {
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          throw new Error('连接未通过，请检查 API Key、Workspace ID 和地域');
        }
        if (response.status === 429) {
          throw new Error('百炼服务当前限流或额度不足，请稍后再试');
        }
        if (response.status >= 500) {
          throw new Error('百炼服务暂时不可用，请稍后再试');
        }
        throw new Error('百炼 OCR 连接测试失败');
      }

      let payload: {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      try {
        payload = (await readBoundedJson(response, this.maxResponseBytes)) as typeof payload;
      } catch {
        throw new Error('百炼 OCR 返回了无法识别的响应');
      }
      if (typeof payload.choices?.[0]?.message?.content !== 'string') {
        throw new Error('百炼 OCR 返回了无法识别的响应');
      }
      return { model: 'qwen3.5-ocr' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function endpointFor(workspaceId: string, region: BailianRegion): string {
  if (region !== 'cn-beijing') throw new Error('当前暂不支持该百炼地域');
  const normalizedWorkspaceId = normalizeBailianWorkspaceId(workspaceId);
  return `https://${normalizedWorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('response too large');
  }
  if (!response.body) throw new Error('response body missing');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response too large');
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
