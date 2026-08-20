import { describe, expect, it, vi } from 'vitest';

import { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';
import { OpenAICompatibleCandidateAdjudicator } from '../src/adapters/recognition/openai-compatible-candidate-adjudicator';
import type { OcrCallRecorded } from '../src/core/ocr-usage';

class RecordingRecorder {
  public readonly calls: OcrCallRecorded[] = [];

  public recordCall(call: OcrCallRecorded): void {
    this.calls.push(call);
  }
}

function successfulRecognitionResponse(): Response {
  return new Response(JSON.stringify({
    output: {
      choices: [{
        finish_reason: 'stop',
        message: {
          content: [{
            ocr_result: {
              kv_result: {},
            },
          }],
        },
      }],
    },
    request_id: 'req-recognition-1',
  }), { status: 200 });
}

function successfulConnectionTestResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: '连接测试图片中的文字' } }],
  }), { status: 200 });
}

const OCR_SOURCE = {
  absolutePath: '/tmp/source.png',
  originalName: 'source.png',
  mimeType: 'image/png',
  sha256: 'a'.repeat(64),
  bytes: Buffer.from('synthetic-png-bytes'),
};

describe('OCR 用量计数契约', () => {
  it('主识别成功计一次 recognition 成功调用', async () => {
    const recorder = new RecordingRecorder();
    const request = vi.fn(async () => successfulRecognitionResponse());
    const client = new BailianOcrClient(request, { onOcrCall: recorder });
    await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
      sellerAccount: '默认闲鱼账号',
      source: OCR_SOURCE,
    }).catch(() => undefined);
    expect(recorder.calls).toEqual([
      expect.objectContaining({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      }),
    ]);
  });

  it('主识别网络失败计一次 recognition 失败调用', async () => {
    const recorder = new RecordingRecorder();
    const request = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = new BailianOcrClient(request, { onOcrCall: recorder });
    await expect(client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
      sellerAccount: '默认闲鱼账号',
      source: OCR_SOURCE,
    })).rejects.toThrow(/无法连接百炼服务/u);
    expect(recorder.calls).toEqual([
      expect.objectContaining({ kind: 'recognition', outcome: 'failure' }),
    ]);
  });

  it('主识别 HTTP 非 2xx 计一次失败调用', async () => {
    const recorder = new RecordingRecorder();
    const request = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const client = new BailianOcrClient(request, { onOcrCall: recorder });
    await expect(client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
      sellerAccount: '默认闲鱼账号',
      source: OCR_SOURCE,
    })).rejects.toThrow(/限流或额度不足/u);
    expect(recorder.calls).toEqual([
      expect.objectContaining({ kind: 'recognition', outcome: 'failure' }),
    ]);
  });

  it('连接测试成功计一次 connection_test 调用', async () => {
    const recorder = new RecordingRecorder();
    const request = vi.fn(async () => successfulConnectionTestResponse());
    const client = new BailianOcrClient(request, { onOcrCall: recorder });
    await client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
    });
    expect(recorder.calls).toEqual([
      expect.objectContaining({
        kind: 'connection_test',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      }),
    ]);
  });

  it('连接测试失败计一次 connection_test 失败调用', async () => {
    const recorder = new RecordingRecorder();
    const request = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const client = new BailianOcrClient(request, { onOcrCall: recorder });
    await expect(client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
    })).rejects.toThrow(/连接未通过/u);
    expect(recorder.calls).toEqual([
      expect.objectContaining({ kind: 'connection_test', outcome: 'failure' }),
    ]);
  });

  it('候选裁决成功计一次 candidate_adjudication 调用', async () => {
    const recorder = new RecordingRecorder();
    const adjudicator = new OpenAICompatibleCandidateAdjudicator({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      fetcher: async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decisions: [{
                ambiguityId: 'ambiguity-a',
                resolution: 'selected',
                candidateId: 'candidate-a',
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      onOcrCall: recorder,
    });
    const result = await adjudicator.adjudicate([{
      ambiguityId: 'ambiguity-a',
      region: 'platform_status',
      field: 'status',
      contextLines: [{
        lineId: 'line-1',
        text: '候选 A',
        left: 0,
        top: 0,
        right: 10,
        bottom: 10,
      }],
      candidates: [{
        candidateId: 'candidate-a',
        displayText: '候选 A',
        evidenceRefs: [{ lineId: 'line-1' }],
      }, {
        candidateId: 'candidate-b',
        displayText: '候选 B',
        evidenceRefs: [{ lineId: 'line-1' }],
      }],
    }]);
    expect(result.status).toBe('completed');
    expect(recorder.calls).toEqual([
      expect.objectContaining({
        kind: 'candidate_adjudication',
        outcome: 'success',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      }),
    ]);
  });

  it('候选裁决网络失败计一次失败调用并返回失败结果', async () => {
    const recorder = new RecordingRecorder();
    const adjudicator = new OpenAICompatibleCandidateAdjudicator({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      fetcher: async () => {
        throw new Error('network down');
      },
      onOcrCall: recorder,
    });
    const result = await adjudicator.adjudicate([{
      ambiguityId: 'ambiguity-a',
      region: 'platform_status',
      field: 'status',
      contextLines: [{
        lineId: 'line-1',
        text: '候选 A',
        left: 0,
        top: 0,
        right: 10,
        bottom: 10,
      }],
      candidates: [{
        candidateId: 'candidate-a',
        displayText: '候选 A',
        evidenceRefs: [{ lineId: 'line-1' }],
      }, {
        candidateId: 'candidate-b',
        displayText: '候选 B',
        evidenceRefs: [{ lineId: 'line-1' }],
      }],
    }]);
    expect(result.status).toBe('failed');
    expect(recorder.calls).toEqual([
      expect.objectContaining({ kind: 'candidate_adjudication', outcome: 'failure' }),
    ]);
  });

  it('候选裁决连接测试复用 adjudicate 计数', async () => {
    const recorder = new RecordingRecorder();
    const adjudicator = new OpenAICompatibleCandidateAdjudicator({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      fetcher: async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decisions: [{
                ambiguityId: 'candidate-verification-connection-check',
                resolution: 'selected',
                candidateId: 'expected-blue',
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      onOcrCall: recorder,
    });
    const result = await adjudicator.testConnection();
    expect(result.ok).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      kind: 'candidate_adjudication',
      outcome: 'success',
    });
  });

  it('不注入记录器时所有路径照常工作且不计数', async () => {
    const request = vi.fn(async () => successfulConnectionTestResponse());
    const client = new BailianOcrClient(request);
    await client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-test',
    });
    const adjudicator = new OpenAICompatibleCandidateAdjudicator({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-test',
      fetcher: async () => new Response('{}', { status: 200 }),
    });
    await adjudicator.testConnection();
  });
});
