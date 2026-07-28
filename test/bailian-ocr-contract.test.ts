import { describe, expect, it, vi } from 'vitest';

import { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';

describe('阿里云百炼 OCR 请求契约', () => {
  it('用固定北京端点和本机图片 Data URL 显式测试 qwen3.5-ocr 连接', async () => {
    const sentinelApiKey = 'sk-fixed-contract-sentinel';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fixed',
          model: 'qwen3.5-ocr',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'OK',
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const client = new BailianOcrClient(request);

    const result = await client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
    });

    expect(result).toEqual({ model: 'qwen3.5-ocr' });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      'https://ws-test123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${sentinelApiKey}`,
    );
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          image_url?: { url: string };
          text?: string;
        }>;
      }>;
    };
    expect(body.model).toBe('qwen3.5-ocr');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].image_url?.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(body.messages[0].content[0].image_url?.url).not.toContain('http');
    expect(JSON.stringify(body)).not.toContain(sentinelApiKey);
    expect(JSON.stringify(result)).not.toContain(sentinelApiKey);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('在发起网络请求前拒绝可能改变目标主机的 Workspace ID', async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('request must not be called');
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'evil.example.com/path',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-invalid-host',
      }),
    ).rejects.toThrow('Workspace ID 格式无效');
    expect(request).not.toHaveBeenCalled();
  });

  it('认证失败时不把服务端响应或 API Key 带入错误信息', async () => {
    const sentinelApiKey = 'sk-secret-in-remote-error';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          message: `invalid bearer ${sentinelApiKey}`,
          request: 'data:image/png;base64,private-image-content',
        }),
        { status: 401 },
      );
    });
    const client = new BailianOcrClient(request);

    let failure: unknown;
    try {
      await client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      '连接未通过，请检查 API Key、Workspace ID 和地域',
    );
    expect(JSON.stringify(failure)).not.toContain(sentinelApiKey);
    expect((failure as Error).message).not.toContain('private-image-content');
  });

  it('网络异常时不透传可能含敏感数据的底层错误', async () => {
    const sentinelApiKey = 'sk-secret-in-network-error';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      throw new Error(`request failed with ${sentinelApiKey}`);
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      }),
    ).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
  });

  it('响应格式异常时不透传服务端内容或解析错误', async () => {
    const sentinelApiKey = 'sk-secret-in-invalid-json';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(`not-json-${sentinelApiKey}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      }),
    ).rejects.toThrow('百炼 OCR 返回了无法识别的响应');
  });

  it('拒绝超过安全上限的响应正文', async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'x'.repeat(2_048) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new BailianOcrClient(request, { maxResponseBytes: 1_024 });

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-large-response',
      }),
    ).rejects.toThrow('百炼 OCR 返回了无法识别的响应');
  });

  it('到达请求时限后主动中止连接测试', async () => {
    const request = vi.fn((_input: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new BailianOcrClient(request, { timeoutMilliseconds: 5 });

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-timeout',
      }),
    ).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
  });
});
