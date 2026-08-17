import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import type { LocalApplication } from '../src/main/local-application';
import { LocalApplication as LocalApplicationClass } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';
import { removeVersion47ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

function recognition(
  orderNumber: string,
  options: { sourceTitle?: string; sourceSpec?: string; quantity?: number } = {},
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '映射账号甲',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '测***户',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-14 09:00:00',
    orderedAtNormalized: '2026-08-14T09:00:00+08:00',
    paidAtOriginal: '2026-08-14 09:00:08',
    paidAtNormalized: '2026-08-14T09:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: options.sourceTitle ?? '古风娃鞋白模-闲鱼专拍',
      sourceSpec: options.sourceSpec ?? '05M',
      unitPriceCents: 800,
      quantity: options.quantity ?? 1,
      quantityInferred: false,
    }],
  };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

async function openApplication(
  dataDirectory: string,
  result: RecognitionResult,
): Promise<LocalApplication> {
  const application = new LocalApplicationClass(new ControlledRecognizer(result));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  return application;
}

async function confirmOrder(
  dataDirectory: string,
  root: string,
  result: RecognitionResult,
): Promise<{ orderId: string; itemId: string; revision: number }> {
  const application = await openApplication(dataDirectory, result);
  const sourcePath = join(root, `${result.orderNumber}.png`);
  await writeFile(sourcePath, Buffer.from(result.orderNumber));
  const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
  const order = application.confirmDraft(draft);
  application.close();
  openedApplications.splice(openedApplications.indexOf(application), 1);
  return { orderId: order.id, itemId: order.items[0].id, revision: order.revision };
}

function readMappingEvents(databasePath: string): Array<Record<string, unknown>> {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    return database.prepare(`
      SELECT event_type, origin, reason, before_json, after_json
      FROM product_mapping_events
      ORDER BY sequence
    `).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

describe('商品映射可视列表与统计', () => {
  it('按关联事实投影统计口径，并为每条映射投影命中订单数与最近使用时间', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-stats-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const seed = await openApplication(dataDirectory, recognition('XY-MGMT-SEED'));
    const product = seed.createStandardProduct({
      sku: 'SKU-MGMT-001',
      name: '映射统计商品',
      specification: '规格',
    });
    const workspaceMapping = seed.createProductMapping(product.id, {
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
      sourceSpec: '05M',
      scope: 'workspace',
    });
    const accountMapping = seed.createProductMapping(product.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    seed.close();
    openedApplications.splice(openedApplications.indexOf(seed), 1);

    // 两笔订单命中工作区级映射（source='mapping'），一笔订单人工关联。
    await confirmOrder(dataDirectory, root, recognition('XY-MGMT-0001', { quantity: 2 }));
    await confirmOrder(dataDirectory, root, recognition('XY-MGMT-0002'));
    const manual = await confirmOrder(dataDirectory, root, recognition('XY-MGMT-0003', {
      sourceTitle: '完全无关的商品',
      sourceSpec: '均码',
    }));

    const session = await openApplication(
      dataDirectory,
      recognition('XY-MGMT-UNUSED', { sourceTitle: '无匹配', sourceSpec: '无' }),
    );
    session.updateOrderItemStandardization(manual.orderId, manual.itemId, {
      standardProductId: product.id,
      expectedRevision: manual.revision,
    });
    session.disableProductMapping(accountMapping.id, { reason: '不再销售该原文商品' });

    expect(session.getProductMappingStats(product.id)).toEqual({
      activeMappingCount: 1,
      linkedOrderCount: 3,
      linkedItemCount: 3,
      linkedTotalQuantity: 4,
    });

    const mappings = session.listProductMappings(product.id);
    expect(mappings).toHaveLength(2);
    const active = mappings.find(({ id }) => id === workspaceMapping.id);
    expect(active).toMatchObject({
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
      sourceSpec: '05M',
      sourceTitleKey: '古风娃鞋白模-闲鱼专拍',
      sourceSpecKey: '05m',
      standardProductId: product.id,
      targetProductSku: 'SKU-MGMT-001',
      targetProductName: '映射统计商品',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      status: 'active',
      origin: 'manual',
      hitOrderCount: 2,
    });
    expect(typeof active?.lastUsedAt).toBe('string');
    const disabled = mappings.find(({ id }) => id === accountMapping.id);
    expect(disabled).toMatchObject({
      status: 'disabled',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
      hitOrderCount: 0,
      lastUsedAt: null,
    });

    // 列表搜索按原文标题或规格过滤。
    expect(session.listProductMappings(product.id, '白模')
      .map(({ id }) => id)).toEqual([workspaceMapping.id]);
    expect(session.listProductMappings(product.id, '小号')
      .map(({ id }) => id)).toEqual([accountMapping.id]);
    expect(session.listProductMappings(product.id, '不存在的原文')).toEqual([]);

    // 停用与建立均写不可变映射变更事件。
    const events = readMappingEvents(databasePath);
    expect(events.map(({ event_type }) => event_type)).toEqual([
      'created',
      'created',
      'disabled',
    ]);
    expect(events[2]).toMatchObject({ origin: 'manual', reason: '不再销售该原文商品' });
    expect(JSON.parse(events[2].before_json as string)).toMatchObject({
      scope: 'current_account',
      status: 'active',
    });
    expect(JSON.parse(events[2].after_json as string)).toMatchObject({ status: 'disabled' });
    session.close();
    openedApplications.splice(openedApplications.indexOf(session), 1);
  });

  it('新增映射沿用同范围同原文冲突报错，同目标幂等，停用后不再占用该范围', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-create-'));
    const dataDirectory = join(root, '数据');

    const application = await openApplication(dataDirectory, recognition('XY-CREATE-SEED'));
    const product = application.createStandardProduct({
      sku: 'SKU-CREATE-A',
      name: '新增商品甲',
      specification: '规格',
    });
    const other = application.createStandardProduct({
      sku: 'SKU-CREATE-B',
      name: '新增商品乙',
      specification: '规格',
    });

    const created = application.createProductMapping(product.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    expect(created).toMatchObject({ origin: 'manual', status: 'active' });

    const idempotent = application.createProductMapping(product.id, {
      sourceTitle: ' 冲突原文 ',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    expect(idempotent.id).toBe(created.id);
    expect(application.listProductMappings(product.id)).toHaveLength(1);

    expect(() => application.createProductMapping(other.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    })).toThrow('当前平台与卖家账号已存在指向其他 SKU 的商品映射');

    application.createProductMapping(product.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'current_platform',
      platform: 'xianyu',
    });
    expect(() => application.createProductMapping(other.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'current_platform',
      platform: 'xianyu',
    })).toThrow('当前平台已存在指向其他 SKU 的商品映射');

    application.createProductMapping(product.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    });
    expect(() => application.createProductMapping(other.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    })).toThrow('工作区已存在指向其他 SKU 的商品映射');

    // 停用后释放该范围，可重新建立指向其他 SKU 的映射。
    application.disableProductMapping(created.id, { reason: '释放账号级原文' });
    const recreated = application.createProductMapping(other.id, {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    expect(recreated.standardProductId).toBe(other.id);

    expect(() => application.createProductMapping('missing-product', {
      sourceTitle: '冲突原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    })).toThrow('未找到标准商品');
  });

  it('更正映射写事件且不改写历史订单，停用后不再参与匹配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-correct-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const seed = await openApplication(dataDirectory, recognition('XY-CORRECT-SEED'));
    const product = seed.createStandardProduct({
      sku: 'SKU-CORRECT-A',
      name: '更正前商品',
      specification: '规格',
    });
    const target = seed.createStandardProduct({
      sku: 'SKU-CORRECT-B',
      name: '更正后商品',
      specification: '规格',
    });
    const mapping = seed.createProductMapping(product.id, {
      sourceTitle: '待更正原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    });
    seed.close();
    openedApplications.splice(openedApplications.indexOf(seed), 1);

    const linked = await confirmOrder(dataDirectory, root, recognition('XY-CORRECT-0001', {
      sourceTitle: '待更正原文',
      sourceSpec: '规格一',
    }));

    const session = await openApplication(dataDirectory, recognition('XY-CORRECT-0002', {
      sourceTitle: '待更正原文',
      sourceSpec: '规格一',
    }));
    expect(() => session.correctProductMapping(mapping.id, {
      standardProductId: product.id,
      reason: '目标没有变化',
    })).toThrow('商品映射未发生变化');
    expect(() => session.correctProductMapping(mapping.id, {
      standardProductId: target.id,
      reason: '  ',
    })).toThrow('映射变更原因无效');

    const corrected = session.correctProductMapping(mapping.id, {
      standardProductId: target.id,
      reason: '目标 SKU 选错',
    });
    expect(corrected).toMatchObject({
      standardProductId: target.id,
      targetProductSku: 'SKU-CORRECT-B',
    });

    // 历史订单保持原关联，更正只影响未来匹配（规格 4.5）。
    expect(session.getOrder(linked.orderId).order.items[0]).toMatchObject({
      standardProduct: { id: product.id },
      standardizationSource: 'mapping',
    });
    const sourcePath = join(root, '更正后.png');
    await writeFile(sourcePath, Buffer.from('mapping-corrected'));
    const [draft] = (await session.submitRecognitionBatch([sourcePath])).drafts;
    expect(session.previewDraftProductStandardizations(draft)[0]).toMatchObject({
      automaticProduct: { id: target.id },
      automaticSource: 'mapping',
      automaticMappingScope: 'workspace',
    });

    // 停用后不再参与匹配，且已停用映射不能更正。
    session.disableProductMapping(mapping.id, { reason: '规则作废' });
    const [disabledDraft] = (await session.submitRecognitionBatch([sourcePath])).drafts;
    expect(session.previewDraftProductStandardizations(disabledDraft)[0]).toMatchObject({
      automaticProduct: null,
      automaticSource: null,
      automaticMappingScope: null,
    });
    expect(() => session.correctProductMapping(mapping.id, {
      standardProductId: product.id,
      reason: '已停用不能再更正',
    })).toThrow('已停用的商品映射不能更正');
    expect(() => session.disableProductMapping(mapping.id, { reason: '重复停用' }))
      .toThrow('商品映射已停用');

    const events = readMappingEvents(databasePath);
    expect(events.map(({ event_type }) => event_type)).toEqual([
      'created',
      'corrected',
      'disabled',
    ]);
    expect(JSON.parse(events[1].before_json as string)).toMatchObject({
      standardProductId: product.id,
    });
    expect(JSON.parse(events[1].after_json as string)).toMatchObject({
      standardProductId: target.id,
    });
    expect(events[1]).toMatchObject({ origin: 'manual', reason: '目标 SKU 选错' });
    session.close();
    openedApplications.splice(openedApplications.indexOf(session), 1);
  });

  it('更正范围时重新检查同范围同原文冲突', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-scope-conflict-'));
    const dataDirectory = join(root, '数据');

    const application = await openApplication(dataDirectory, recognition('XY-SCOPE-CONFLICT'));
    const product = application.createStandardProduct({
      sku: 'SKU-SCOPE-A',
      name: '范围商品甲',
      specification: '规格',
    });
    const other = application.createStandardProduct({
      sku: 'SKU-SCOPE-B',
      name: '范围商品乙',
      specification: '规格',
    });
    const workspaceMapping = application.createProductMapping(product.id, {
      sourceTitle: '范围冲突原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    });
    const accountMapping = application.createProductMapping(other.id, {
      sourceTitle: '范围冲突原文',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });

    expect(() => application.correctProductMapping(accountMapping.id, {
      scope: 'workspace',
      reason: '与工作区级映射冲突',
    })).toThrow('工作区已存在指向其他 SKU 的商品映射');

    const widened = application.correctProductMapping(accountMapping.id, {
      scope: 'current_platform',
      platform: 'xianyu',
      reason: '放宽到整个平台',
    });
    expect(widened).toMatchObject({
      scope: 'current_platform',
      platform: 'xianyu',
      sellerAccount: null,
    });
    expect(workspaceMapping.scope).toBe('workspace');
  });

  it('删除映射移除行但保留不可变事件留痕', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-delete-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const application = await openApplication(dataDirectory, recognition('XY-DELETE-SEED'));
    const product = application.createStandardProduct({
      sku: 'SKU-DELETE-A',
      name: '删除商品',
      specification: '规格',
    });
    const mapping = application.createProductMapping(product.id, {
      sourceTitle: '待删除原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    });

    expect(() => application.deleteProductMapping(mapping.id, { reason: ' ' }))
      .toThrow('映射变更原因无效');
    application.deleteProductMapping(mapping.id, { reason: '录入错误，重新建立' });
    expect(application.listProductMappings(product.id)).toEqual([]);
    expect(() => application.deleteProductMapping(mapping.id, { reason: '重复删除' }))
      .toThrow('未找到商品映射');
    // 删除后仍可按标准商品追溯变更事件。
    const traced = application.listProductMappingEvents(product.id);
    expect(traced.map((event) => event.eventType)).toEqual(['created', 'deleted']);
    expect(traced[1]).toMatchObject({
      mappingId: mapping.id,
      standardProductId: product.id,
      origin: 'manual',
      reason: '录入错误，重新建立',
      after: null,
    });
    expect(traced[1].before).toMatchObject({ sourceTitle: '待删除原文', status: 'active' });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const events = readMappingEvents(databasePath);
    expect(events.map(({ event_type }) => event_type)).toEqual(['created', 'deleted']);
    expect(JSON.parse(events[1].before_json as string)).toMatchObject({
      sourceTitle: '待删除原文',
      standardProductId: product.id,
      status: 'active',
    });
    expect(events[1].after_json).toBeNull();
    expect(events[1]).toMatchObject({ origin: 'manual', reason: '录入错误，重新建立' });

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM product_mappings').get())
        .toEqual({ count: 0 });
      expect(() => database.prepare(`
        UPDATE product_mapping_events SET reason = '篡改'
      `).run()).toThrow(/product mapping events are immutable/);
      expect(() => database.prepare(`
        DELETE FROM product_mapping_events
      `).run()).toThrow(/product mapping events are immutable/);
    } finally {
      database.close();
    }
  });

  it('最近使用时间只在映射真正应用到订单时更新，预览不计入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-last-used-'));
    const dataDirectory = join(root, '数据');

    const seed = await openApplication(dataDirectory, recognition('XY-LAST-USED-SEED'));
    const product = seed.createStandardProduct({
      sku: 'SKU-LAST-USED',
      name: '使用时间商品',
      specification: '规格',
    });
    const mapping = seed.createProductMapping(product.id, {
      sourceTitle: '最近使用原文',
      sourceSpec: '规格一',
      scope: 'workspace',
    });
    seed.close();
    openedApplications.splice(openedApplications.indexOf(seed), 1);

    const session = await openApplication(dataDirectory, recognition('XY-LAST-USED-0001', {
      sourceTitle: '最近使用原文',
      sourceSpec: '规格一',
    }));
    const sourcePath = join(root, '最近使用.png');
    await writeFile(sourcePath, Buffer.from('mapping-last-used'));
    const [draft] = (await session.submitRecognitionBatch([sourcePath])).drafts;
    session.previewDraftProductStandardizations(draft);
    expect(session.listProductMappings(product.id)[0]).toMatchObject({ lastUsedAt: null });

    session.confirmDraft(draft);
    const after = session.listProductMappings(product.id)[0];
    expect(after.id).toBe(mapping.id);
    expect(typeof after.lastUsedAt).toBe('string');
    expect(after.hitOrderCount).toBe(1);
    session.close();
    openedApplications.splice(openedApplications.indexOf(session), 1);
  });

  it('校对确认建立的映射记录确认来源并写建立事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-origin-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const sourcePath = join(root, '确认建立.png');
    await writeFile(sourcePath, Buffer.from('mapping-origin'));

    const application = await openApplication(dataDirectory, recognition('XY-ORIGIN-0001'));
    const product = application.createStandardProduct({
      sku: 'SKU-ORIGIN',
      name: '确认来源商品',
      specification: '规格',
    });
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    application.confirmDraft(draft, undefined, {}, [{
      draftItemId: draft.items[0].id,
      standardProductId: product.id,
      createMapping: true,
    }]);

    expect(application.listProductMappings(product.id)).toHaveLength(1);
    expect(application.listProductMappings(product.id)[0]).toMatchObject({
      origin: 'confirmation',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
      hitOrderCount: 0,
    });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const events = readMappingEvents(databasePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'created',
      origin: 'confirmation',
      reason: '',
    });
    expect(JSON.parse(events[0].after_json as string)).toMatchObject({
      standardProductId: product.id,
      scope: 'current_account',
      status: 'active',
    });
  });

  it('降级守卫拒绝移除带映射变更留痕的 v47 数据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-v47-guard-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const application = await openApplication(dataDirectory, recognition('XY-V47-GUARD'));
    const product = application.createStandardProduct({
      sku: 'SKU-V47-GUARD',
      name: '降级守卫商品',
      specification: '规格',
    });
    application.deleteProductMapping(
      application.createProductMapping(product.id, {
        sourceTitle: '会被删除的原文',
        sourceSpec: '规格',
        scope: 'workspace',
      }).id,
      { reason: '验证降级守卫' },
    );
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(() => removeVersion47ExtensionArtifacts(database))
        .toThrow('v47 测试降级前必须移除映射变更留痕数据');
    } finally {
      database.close();
    }
  });

  it('从 v46 升级后为存量映射回填状态与来源，唯一索引只约束有效映射', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-v46-migration-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const before = await openApplication(dataDirectory, recognition('XY-V46-LEGACY'));
    const product = before.createStandardProduct({
      sku: 'SKU-V46-LEGACY',
      name: '升级前映射商品',
      specification: '规格',
    });
    before.close();
    openedApplications.splice(openedApplications.indexOf(before), 1);

    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      removeVersion47ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 46 });
      const columns = (legacy.prepare('PRAGMA table_info(product_mappings)').all() as Array<{
        name: string;
      }>).map(({ name }) => name);
      expect(columns).not.toContain('status');
      expect(columns).not.toContain('origin');
      expect(columns).not.toContain('last_used_at');
      // 以 v46 结构直接写入一条存量映射，等待升级回填。
      legacy.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('v46-legacy-mapping', '古风娃鞋白模-闲鱼专拍', '05M',
          '古风娃鞋白模-闲鱼专拍', '05m', ?,
          'current_account', 'xianyu', '映射账号甲',
          '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(product.id);
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare(`
        SELECT status, origin, last_used_at FROM product_mappings WHERE id = 'v46-legacy-mapping'
      `).get()).toEqual({
        status: 'active',
        origin: 'confirmation',
        last_used_at: null,
      });
      expect(migrated.database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE tbl_name = 'product_mapping_events'
        ORDER BY name
      `).all()).toEqual([
        { name: 'product_mapping_events' },
        { name: 'product_mapping_events_are_immutable_on_delete' },
        { name: 'product_mapping_events_are_immutable_on_update' },
        { name: 'product_mapping_events_by_product' },
        { name: 'sqlite_autoindex_product_mapping_events_1' },
      ]);
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // 唯一索引只约束有效映射：停用后同范围同原文可重新建立。
      migrated.database.prepare(`
        UPDATE product_mappings SET status = 'disabled' WHERE id = ?
      `).run('v46-legacy-mapping');
      migrated.database.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account,
          status, origin, created_at, updated_at
        ) VALUES ('v47-recreated', '古风娃鞋白模-闲鱼专拍', '05M',
          '古风娃鞋白模-闲鱼专拍', '05m', ?,
          'current_account', 'xianyu', '映射账号甲',
          'active', 'manual', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')
      `).run(product.id);
      expect(() => migrated.database.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account,
          status, origin, created_at, updated_at
        ) VALUES ('v47-duplicate', '古风娃鞋白模-闲鱼专拍', '05M',
          '古风娃鞋白模-闲鱼专拍', '05m', ?,
          'current_account', 'xianyu', '映射账号甲',
          'active', 'manual', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')
      `).run(product.id)).toThrow(/UNIQUE/u);
    } finally {
      migrated.close();
    }

    // 迁移幂等：再次打开不重复执行且不报错。
    const reopened = Workspace.open(dataDirectory);
    try {
      expect(reopened.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});
