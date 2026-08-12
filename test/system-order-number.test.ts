import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import {
  shanghaiDateKey,
  systemOrderNumberForSequence,
} from '../src/core/system-order-number';
import { LocalApplication } from '../src/main/local-application';

const applications: LocalApplication[] = [];

class SequenceRecognizer implements Recognizer {
  public constructor(private readonly results: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.results.shift();
    if (!result) throw new Error('测试识别结果已用尽');
    return {
      result: structuredClone(result),
      evidences: [{
        provider: 'controlled',
        model: 'controlled',
        requestId: '',
        schemaVersion: 1,
        rawResponse: JSON.stringify(result),
      }],
    };
  }
}

function recognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '系统编号测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '编号买家',
    recipient: '编号收件人',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '上海市浦东新区编号路1号',
    addressNormalized: '上海市浦东新区编号路1号',
    province: '上海市',
    city: '上海市',
    district: '浦东新区',
    orderedAtOriginal: '2026-08-13 09:30:00',
    orderedAtNormalized: '2026-08-13T09:30:00+08:00',
    paidAtOriginal: '2026-08-13 09:31:00',
    paidAtNormalized: '2026-08-13T09:31:00+08:00',
    productTotalCents: 1_800,
    shippingFeeCents: 0,
    amountCents: 1_800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '编号测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 1_800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

async function openApplication(results: RecognitionResult[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-system-order-number-'));
  const dataDirectory = join(root, '数据');
  const uploadDirectory = join(root, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  return { application, dataDirectory, uploadDirectory };
}

async function confirmOrder(
  application: LocalApplication,
  uploadDirectory: string,
  index: number,
) {
  const sourcePath = join(uploadDirectory, `订单-${index}.png`);
  await writeFile(sourcePath, Buffer.from(`system-order-number-${index}`));
  const batch = await application.submitRecognitionBatch([sourcePath]);
  return application.confirmDraft(batch.drafts[0]);
}

afterEach(() => {
  vi.useRealTimers();
  for (const application of applications.splice(0)) application.close();
});

describe('永久系统订单编号', () => {
  it('使用北京时间日期和六位当日序号形成固定格式', () => {
    expect(shanghaiDateKey('2026-08-12T15:59:59.999Z')).toBe('20260812');
    expect(shanghaiDateKey('2026-08-12T16:00:00.000Z')).toBe('20260813');
    expect(systemOrderNumberForSequence('20260813', 1)).toBe('20260813-000001');
    expect(() => systemOrderNumberForSequence('20260813', 1_000_000))
      .toThrow('当日系统订单编号已用尽');
  });

  it('在首次入库事务内分配同日递增编号，并可在详情、列表和搜索中稳定使用', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T16:01:00.000Z'));
    const { application, dataDirectory, uploadDirectory } = await openApplication([
      recognition('PLATFORM-001'),
      recognition('PLATFORM-002'),
    ]);

    const first = await confirmOrder(application, uploadDirectory, 1);
    const second = await confirmOrder(application, uploadDirectory, 2);

    expect(first.systemOrderNumber).toBe('20260813-000001');
    expect(second.systemOrderNumber).toBe('20260813-000002');
    expect(application.getOrder(first.id).order.systemOrderNumber)
      .toBe('20260813-000001');
    expect(application.queryOrders({ text: '20260813-000002' }).orders)
      .toEqual([expect.objectContaining({
        id: second.id,
        systemOrderNumber: '20260813-000002',
        orderNumber: 'PLATFORM-002',
      })]);

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE original_orders
        SET system_order_number = '20260813-999999'
        WHERE id = ?
      `).run(first.id)).toThrow(/immutable|不可变/u);
    } finally {
      database.close();
    }
  });

  it('从旧版本按首次入库时间和稳定订单标识确定性回填，并为不同日期分别计数', async () => {
    const { application, dataDirectory, uploadDirectory } = await openApplication([
      recognition('LEGACY-001'),
      recognition('LEGACY-002'),
      recognition('LEGACY-003'),
    ]);
    await confirmOrder(application, uploadDirectory, 1);
    await confirmOrder(application, uploadDirectory, 2);
    await confirmOrder(application, uploadDirectory, 3);
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      const rows = legacy.prepare('SELECT id FROM original_orders ORDER BY id').all() as Array<{ id: string }>;
      legacy.prepare('UPDATE original_orders SET created_at = ? WHERE id = ?')
        .run('2026-08-12T15:59:00.000Z', rows[0].id);
      legacy.prepare('UPDATE original_orders SET created_at = ? WHERE id = ?')
        .run('2026-08-12T15:59:00.000Z', rows[1].id);
      legacy.prepare('UPDATE original_orders SET created_at = ? WHERE id = ?')
        .run('2026-08-12T16:00:00.000Z', rows[2].id);
      legacy.exec(`
        DROP TRIGGER original_orders_system_order_number_is_immutable;
        DROP TRIGGER original_orders_require_system_order_number_on_insert;
        DROP INDEX original_orders_by_system_order_number;
        ALTER TABLE original_orders DROP COLUMN system_order_number;
        DELETE FROM schema_migrations WHERE version = 27;
      `);
    } finally {
      legacy.close();
    }

    const reopened = new LocalApplication(new SequenceRecognizer([]));
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    const migratedDatabase = new DatabaseSync(databasePath);
    try {
      const migrated = migratedDatabase.prepare(`
        SELECT id, system_order_number
        FROM original_orders
        ORDER BY created_at, id
      `).all();
      expect(migrated).toEqual([
        { id: expect.any(String), system_order_number: '20260812-000001' },
        { id: expect.any(String), system_order_number: '20260812-000002' },
        { id: expect.any(String), system_order_number: '20260813-000001' },
      ]);
    } finally {
      migratedDatabase.close();
    }
  });
});
