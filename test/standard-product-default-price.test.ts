import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import {
  normalizeStandardProductInput,
  normalizeUpdateStandardProductInput,
} from '../src/core/product-standardization';
import { LocalApplication } from '../src/main/local-application';
import { removeVersion44ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];
const unusedRecognizer = new ControlledRecognizer({} as RecognitionResult);

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

async function openApplication(): Promise<LocalApplication> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-product-price-'));
  const application = new LocalApplication(unusedRecognizer);
  openedApplications.push(application);
  application.openDataDirectory(join(root, '数据'));
  return application;
}

describe('默认订单单价输入校验', () => {
  it('创建标准商品接受空值或大于等于零的整数分单价', () => {
    expect(normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
    })).toEqual({ sku: 'SKU-1', name: '商品', specification: '规格' });
    expect(normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: null,
    })).toEqual({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: null,
    });
    expect(normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '  首次定价  ',
    })).toEqual({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    expect(() => normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: -1,
    })).toThrowError('默认订单单价无效');
    expect(() => normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 8.5,
    })).toThrowError('默认订单单价无效');
    expect(() => normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: '800',
    })).toThrowError('默认订单单价无效');
    expect(() => normalizeStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      priceChangeReason: '   ',
    })).toThrowError('价格变更原因无效');
  });

  it('修改标准商品必须显式给出默认订单单价当前值', () => {
    expect(normalizeUpdateStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '调价',
      expectedRevision: 2,
    })).toEqual({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '调价',
      expectedRevision: 2,
    });
    expect(normalizeUpdateStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: null,
      expectedRevision: 2,
    })).toMatchObject({ defaultOrderPriceCents: null });
    expect(() => normalizeUpdateStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      expectedRevision: 2,
    })).toThrowError('默认订单单价无效');
    expect(() => normalizeUpdateStandardProductInput({
      sku: 'SKU-1',
      name: '商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: 'x'.repeat(501),
      expectedRevision: 2,
    })).toThrowError('价格变更原因无效');
  });
});

describe('标准商品默认订单单价', () => {
  it('创建时可以保存空值或一个当前默认订单单价，首次定价留事件', async () => {
    const application = await openApplication();

    const withoutPrice = application.createStandardProduct({
      sku: 'SKU-NO-PRICE',
      name: '无价商品',
      specification: '规格',
    });
    expect(withoutPrice.defaultOrderPriceCents).toBeNull();
    expect(application.listStandardProductPriceEvents(withoutPrice.id)).toEqual([]);

    const withPrice = application.createStandardProduct({
      sku: 'SKU-PRICED',
      name: '有价商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    expect(withPrice.defaultOrderPriceCents).toBe(800);
    expect(application.listStandardProductPriceEvents(withPrice.id)).toEqual([
      expect.objectContaining({
        standardProductId: withPrice.id,
        previousDefaultOrderPriceCents: null,
        defaultOrderPriceCents: 800,
        reason: '首次定价',
      }),
    ]);
    expect(application.listStandardProducts()).toEqual([
      expect.objectContaining({ sku: 'SKU-NO-PRICE', defaultOrderPriceCents: null }),
      expect.objectContaining({ sku: 'SKU-PRICED', defaultOrderPriceCents: 800 }),
    ]);
  });

  it('首次定价必须填写价格变更原因', async () => {
    const application = await openApplication();
    expect(() => application.createStandardProduct({
      sku: 'SKU-NO-REASON',
      name: '缺原因商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
    })).toThrowError('默认订单单价变更必须填写原因');
    expect(application.listStandardProducts()).toEqual([]);
  });
});

describe('修改标准商品默认订单单价', () => {
  it('价格变化必须填写原因并留存前后值，未变化不产生事件', async () => {
    const application = await openApplication();
    const product = application.createStandardProduct({
      sku: 'SKU-CHANGE',
      name: '调价商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });

    expect(() => application.updateStandardProduct(product.id, {
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      defaultOrderPriceCents: 900,
      expectedRevision: product.revision,
    })).toThrowError('默认订单单价变更必须填写原因');

    const renamed = application.updateStandardProduct(product.id, {
      sku: product.sku,
      name: '调价商品（新名）',
      specification: product.specification,
      defaultOrderPriceCents: 800,
      expectedRevision: product.revision,
    });
    expect(renamed.defaultOrderPriceCents).toBe(800);
    expect(application.listStandardProductPriceEvents(product.id)).toHaveLength(1);

    const raised = application.updateStandardProduct(product.id, {
      sku: product.sku,
      name: renamed.name,
      specification: product.specification,
      defaultOrderPriceCents: 950,
      priceChangeReason: '供应方涨价',
      expectedRevision: renamed.revision,
    });
    expect(raised.defaultOrderPriceCents).toBe(950);

    const cleared = application.updateStandardProduct(product.id, {
      sku: product.sku,
      name: renamed.name,
      specification: product.specification,
      defaultOrderPriceCents: null,
      priceChangeReason: '不再维护参考价',
      expectedRevision: raised.revision,
    });
    expect(cleared.defaultOrderPriceCents).toBeNull();

    expect(application.listStandardProductPriceEvents(product.id)).toEqual([
      expect.objectContaining({
        previousDefaultOrderPriceCents: null,
        defaultOrderPriceCents: 800,
        reason: '首次定价',
      }),
      expect.objectContaining({
        previousDefaultOrderPriceCents: 800,
        defaultOrderPriceCents: 950,
        reason: '供应方涨价',
      }),
      expect.objectContaining({
        previousDefaultOrderPriceCents: 950,
        defaultOrderPriceCents: null,
        reason: '不再维护参考价',
      }),
    ]);
  });

  it('从 v42 升级后既有商品默认单价为空，价格变更事件不可变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-price-migration-'));
    const dataDirectory = join(root, '数据');
    const application = new LocalApplication(unusedRecognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);
    const product = application.createStandardProduct({
      sku: 'SKU-LEGACY',
      name: '升级前商品',
      specification: '规格',
    });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion44ExtensionArtifacts(legacy);
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version = 43;
        DROP TABLE standard_product_price_events;
        ALTER TABLE standard_products DROP COLUMN default_order_price_cents;
      `);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 42 });
    } finally {
      legacy.close();
    }

    const migrated = new LocalApplication(unusedRecognizer);
    openedApplications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    expect(migrated.listStandardProducts()).toEqual([
      expect.objectContaining({ id: product.id, defaultOrderPriceCents: null }),
    ]);
    expect(migrated.listStandardProductPriceEvents(product.id)).toEqual([]);
    migrated.close();
    openedApplications.splice(openedApplications.indexOf(migrated), 1);

    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 54 });
      verified.prepare(`
        INSERT INTO standard_product_price_events (
          id, standard_product_id,
          previous_default_order_price_cents, default_order_price_cents,
          reason, occurred_at, created_at
        ) VALUES ('event-check', ?, NULL, 100, '检查', '2026-08-15T00:00:00.000Z',
          '2026-08-15T00:00:00.000Z')
      `).run(product.id);
      expect(() => verified.prepare(`
        UPDATE standard_product_price_events SET reason = '篡改' WHERE id = 'event-check'
      `).run()).toThrow(/immutable/u);
      expect(() => verified.prepare(`
        DELETE FROM standard_product_price_events WHERE id = 'event-check'
      `).run()).toThrow(/immutable/u);
    } finally {
      verified.close();
    }
  });
});

describe('价格变更原因边界', () => {
  it('价格未发生变化时不接受变更原因', async () => {
    const application = await openApplication();
    expect(() => application.createStandardProduct({
      sku: 'SKU-REASON-ONLY',
      name: '空手商品',
      specification: '规格',
      priceChangeReason: '没有理由的理由',
    })).toThrowError('价格未变更时不能填写价格变更原因');

    const product = application.createStandardProduct({
      sku: 'SKU-STABLE',
      name: '稳价商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    expect(() => application.updateStandardProduct(product.id, {
      sku: product.sku,
      name: '稳价商品（改名）',
      specification: product.specification,
      defaultOrderPriceCents: 800,
      priceChangeReason: '价格其实没变',
      expectedRevision: product.revision,
    })).toThrowError('价格未变更时不能填写价格变更原因');
    expect(application.listStandardProductPriceEvents(product.id)).toHaveLength(1);
  });
});
