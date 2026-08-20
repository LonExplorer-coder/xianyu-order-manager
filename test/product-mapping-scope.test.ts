import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { normalizeProductText } from '../src/core/product-standardization';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';
import { removeVersion46ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

function recognition(
  orderNumber: string,
  options: { sellerAccount?: string; sourceTitle?: string; sourceSpec?: string } = {},
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: options.sellerAccount ?? '映射账号甲',
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
      quantity: 1,
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
  const application = new LocalApplication(new ControlledRecognizer(result));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  return application;
}

function closeApplication(application: LocalApplication): void {
  application.close();
  openedApplications.splice(openedApplications.indexOf(application), 1);
}

function insertMapping(
  databasePath: string,
  mapping: {
    scope: 'current_account' | 'current_platform' | 'workspace';
    platform: string | null;
    sellerAccount: string | null;
    sourceTitle: string;
    sourceSpec: string;
    standardProductId: string;
  },
): void {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    database.prepare(`
      INSERT INTO product_mappings (
        id, source_title, source_spec, source_title_key, source_spec_key,
        standard_product_id, scope, platform, seller_account, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
    `).run(
      randomUUID(),
      mapping.sourceTitle,
      mapping.sourceSpec,
      normalizeProductText(mapping.sourceTitle),
      normalizeProductText(mapping.sourceSpec),
      mapping.standardProductId,
      mapping.scope,
      mapping.platform,
      mapping.sellerAccount,
    );
  } finally {
    database.close();
  }
}

describe('商品映射三级适用范围', () => {
  it('按当前账号、当前平台、工作区顺序命中并说明命中级别，跨账号与跨平台相互隔离', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-scope-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const seed = await openApplication(dataDirectory, recognition('XY-SCOPE-SEED'));
    const accountProduct = seed.createStandardProduct({
      sku: 'SKU-SCOPE-ACCOUNT',
      name: '账号级商品',
      specification: '规格',
    });
    const platformProduct = seed.createStandardProduct({
      sku: 'SKU-SCOPE-PLATFORM',
      name: '平台级商品',
      specification: '规格',
    });
    const workspaceProduct = seed.createStandardProduct({
      sku: 'SKU-SCOPE-WORKSPACE',
      name: '工作区级商品',
      specification: '规格',
    });
    const fallbackProduct = seed.createStandardProduct({
      sku: 'SKU-SCOPE-FALLBACK',
      name: '兜底商品',
      specification: '规格',
    });
    closeApplication(seed);

    insertMapping(databasePath, {
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
      sourceSpec: '05M',
      standardProductId: accountProduct.id,
    });
    insertMapping(databasePath, {
      scope: 'current_platform',
      platform: 'xianyu',
      sellerAccount: null,
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
      sourceSpec: '05M',
      standardProductId: platformProduct.id,
    });
    insertMapping(databasePath, {
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
      sourceSpec: '05M',
      standardProductId: workspaceProduct.id,
    });
    insertMapping(databasePath, {
      scope: 'current_platform',
      platform: 'taobao',
      sellerAccount: null,
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      standardProductId: platformProduct.id,
    });
    insertMapping(databasePath, {
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      standardProductId: fallbackProduct.id,
    });

    const accountSession = await openApplication(
      dataDirectory,
      recognition('XY-SCOPE-0001', { sellerAccount: '映射账号甲' }),
    );
    const accountSource = join(root, '账号级.png');
    await writeFile(accountSource, Buffer.from('mapping-scope-account'));
    const [accountDraft] = (await accountSession.submitRecognitionBatch([accountSource])).drafts;
    expect(accountSession.previewDraftProductStandardizations(accountDraft)[0]).toMatchObject({
      automaticProduct: { id: accountProduct.id },
      automaticSource: 'mapping',
      automaticMappingScope: 'current_account',
      candidates: [],
    });
    expect(accountSession.confirmDraft(accountDraft).items[0]).toMatchObject({
      standardProduct: { id: accountProduct.id },
      standardizationSource: 'mapping',
    });
    closeApplication(accountSession);

    const platformSession = await openApplication(
      dataDirectory,
      recognition('XY-SCOPE-0002', { sellerAccount: '映射账号乙' }),
    );
    const platformSource = join(root, '平台级.png');
    await writeFile(platformSource, Buffer.from('mapping-scope-platform'));
    const [platformDraft] = (await platformSession.submitRecognitionBatch([platformSource])).drafts;
    expect(platformSession.previewDraftProductStandardizations(platformDraft)[0]).toMatchObject({
      automaticProduct: { id: platformProduct.id },
      automaticSource: 'mapping',
      automaticMappingScope: 'current_platform',
    });
    expect(platformSession.confirmDraft(platformDraft).items[0]).toMatchObject({
      standardProduct: { id: platformProduct.id },
      standardizationSource: 'mapping',
    });
    closeApplication(platformSession);

    // 同平台账号不会命中其他平台映射，回退到工作区级。
    const workspaceSession = await openApplication(
      dataDirectory,
      recognition('XY-SCOPE-0003', {
        sellerAccount: '映射账号丙',
        sourceTitle: '十二分娃鞋白胚',
        sourceSpec: '小号',
      }),
    );
    const workspaceSource = join(root, '工作区级.png');
    await writeFile(workspaceSource, Buffer.from('mapping-scope-workspace'));
    const [workspaceDraft] = (await workspaceSession
      .submitRecognitionBatch([workspaceSource])).drafts;
    expect(workspaceSession.previewDraftProductStandardizations(workspaceDraft)[0]).toMatchObject({
      automaticProduct: { id: fallbackProduct.id },
      automaticSource: 'mapping',
      automaticMappingScope: 'workspace',
    });
    expect(workspaceSession.confirmDraft(workspaceDraft).items[0]).toMatchObject({
      standardProduct: { id: fallbackProduct.id },
      standardizationSource: 'mapping',
    });
    closeApplication(workspaceSession);
  });

  it('校对确认建立映射时默认保存为当前平台与当前账号级', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-default-scope-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const sourcePath = join(root, '默认级.png');
    await writeFile(sourcePath, Buffer.from('mapping-default-scope'));

    const application = await openApplication(
      dataDirectory,
      recognition('XY-DEFAULT-SCOPE', { sellerAccount: '默认账号' }),
    );
    const product = application.createStandardProduct({
      sku: 'SKU-DEFAULT-SCOPE',
      name: '默认级商品',
      specification: '规格',
    });
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    application.confirmDraft(draft, undefined, {}, [{
      draftItemId: draft.items[0].id,
      standardProductId: product.id,
      createMapping: true,
    }]);
    closeApplication(application);

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(database.prepare(`
        SELECT scope, platform, seller_account FROM product_mappings
      `).all()).toEqual([{
        scope: 'current_account',
        platform: 'xianyu',
        seller_account: '默认账号',
      }]);
    } finally {
      database.close();
    }
  });

  it('同范围同原文指向其他 SKU 时抛出明确错误，指向同一 SKU 时幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-conflict-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const firstSource = join(root, '首次.png');
    await writeFile(firstSource, Buffer.from('mapping-conflict-first'));

    const first = await openApplication(dataDirectory, recognition('XY-CONFLICT-0001'));
    const productA = first.createStandardProduct({
      sku: 'SKU-CONFLICT-A',
      name: '冲突商品甲',
      specification: '规格',
    });
    const productB = first.createStandardProduct({
      sku: 'SKU-CONFLICT-B',
      name: '冲突商品乙',
      specification: '规格',
    });
    const [firstDraft] = (await first.submitRecognitionBatch([firstSource])).drafts;
    first.confirmDraft(firstDraft, undefined, {}, [{
      draftItemId: firstDraft.items[0].id,
      standardProductId: productA.id,
      createMapping: true,
    }]);
    closeApplication(first);

    const second = await openApplication(dataDirectory, recognition('XY-CONFLICT-0002'));
    const secondSource = join(root, '再次.png');
    await writeFile(secondSource, Buffer.from('mapping-conflict-second'));
    const [secondDraft] = (await second.submitRecognitionBatch([secondSource])).drafts;
    second.confirmDraft(secondDraft, undefined, {}, [{
      draftItemId: secondDraft.items[0].id,
      standardProductId: productA.id,
      createMapping: true,
    }]);
    closeApplication(second);

    const third = await openApplication(dataDirectory, recognition('XY-CONFLICT-0003'));
    const thirdSource = join(root, '冲突.png');
    await writeFile(thirdSource, Buffer.from('mapping-conflict-third'));
    const [thirdDraft] = (await third.submitRecognitionBatch([thirdSource])).drafts;
    expect(() => third.confirmDraft(thirdDraft, undefined, {}, [{
      draftItemId: thirdDraft.items[0].id,
      standardProductId: productB.id,
      createMapping: true,
    }])).toThrowError('当前平台与卖家账号已存在指向其他 SKU 的商品映射');
    expect(third.getDraft(thirdDraft.id).status).toBe('awaiting_review');
    closeApplication(third);

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(database.prepare(`
        SELECT standard_product_id FROM product_mappings
      `).all()).toEqual([{ standard_product_id: productA.id }]);
    } finally {
      database.close();
    }
  });

  it('映射冲突时单笔例外只关联本次订单商品，不修改映射也不污染未来自动匹配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-exception-'));
    const dataDirectory = join(root, '数据');
    const firstSource = join(root, '首次.png');
    await writeFile(firstSource, Buffer.from('mapping-exception-first'));

    const first = await openApplication(dataDirectory, recognition('XY-EXCEPTION-0001'));
    const productA = first.createStandardProduct({
      sku: 'SKU-EXCEPTION-A',
      name: '例外商品甲',
      specification: '规格',
    });
    const productB = first.createStandardProduct({
      sku: 'SKU-EXCEPTION-B',
      name: '例外商品乙',
      specification: '规格',
    });
    const [firstDraft] = (await first.submitRecognitionBatch([firstSource])).drafts;
    first.confirmDraft(firstDraft, undefined, {}, [{
      draftItemId: firstDraft.items[0].id,
      standardProductId: productA.id,
      createMapping: true,
    }]);
    closeApplication(first);

    // 同范围同原文已指向 SKU-A：不勾选建立映射即单笔例外，只关联到 SKU-B
    const secondSource = join(root, '例外.png');
    await writeFile(secondSource, Buffer.from('mapping-exception-second'));
    const second = await openApplication(dataDirectory, recognition('XY-EXCEPTION-0002'));
    const [secondDraft] = (await second.submitRecognitionBatch([secondSource])).drafts;
    const before = second.listProductMappings(productA.id);
    expect(before).toHaveLength(1);
    expect(before[0].lastUsedAt).toBeNull();
    const confirmed = second.confirmDraft(secondDraft, undefined, {}, [{
      draftItemId: secondDraft.items[0].id,
      standardProductId: productB.id,
      createMapping: false,
    }]);
    expect(confirmed.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: productB.id }),
      standardizationSource: 'manual',
    });
    // 映射未新增、未更正、未触碰最近使用时间
    expect(second.listProductMappings(productB.id)).toEqual([]);
    expect(second.listProductMappings(productA.id)).toEqual(before);
    closeApplication(second);

    // 未来同原文识别仍命中旧映射
    const thirdSource = join(root, '再次.png');
    await writeFile(thirdSource, Buffer.from('mapping-exception-third'));
    const third = await openApplication(dataDirectory, recognition('XY-EXCEPTION-0003'));
    const [thirdDraft] = (await third.submitRecognitionBatch([thirdSource])).drafts;
    expect(third.previewDraftProductStandardizations(thirdDraft)[0]).toMatchObject({
      automaticProduct: expect.objectContaining({ id: productA.id }),
      automaticSource: 'mapping',
      automaticMappingScope: 'current_account',
    });
    closeApplication(third);
  });

  it('映射全部落空时仍按唯一的标题规格完全一致自动关联', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-exact-fallback-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');

    const seed = await openApplication(dataDirectory, recognition('XY-EXACT-SEED'));
    const exactProduct = seed.createStandardProduct({
      sku: 'SKU-EXACT-FALLBACK',
      name: '古风娃鞋白模',
      specification: '05M',
    });
    const otherProduct = seed.createStandardProduct({
      sku: 'SKU-EXACT-OTHER',
      name: '其他商品',
      specification: '规格',
    });
    closeApplication(seed);

    insertMapping(databasePath, {
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '其他账号',
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      standardProductId: otherProduct.id,
    });

    const application = await openApplication(
      dataDirectory,
      recognition('XY-EXACT-0001', {
        sellerAccount: '映射账号甲',
        sourceTitle: '古风娃鞋白模',
        sourceSpec: '05M',
      }),
    );
    const sourcePath = join(root, '精确兜底.png');
    await writeFile(sourcePath, Buffer.from('mapping-exact-fallback'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    expect(application.previewDraftProductStandardizations(draft)[0]).toMatchObject({
      automaticProduct: { id: exactProduct.id },
      automaticSource: 'exact',
      automaticMappingScope: null,
      candidates: [],
    });
    expect(application.confirmDraft(draft).items[0]).toMatchObject({
      standardProduct: { id: exactProduct.id },
      standardizationSource: 'exact',
    });
    closeApplication(application);
  });

  it('从 v45 升级后存量映射回填为工作区级，约束、索引与全局命中行为保持', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-v45-migration-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const firstSource = join(root, '升级前.png');
    await writeFile(firstSource, Buffer.from('mapping-v45-before'));

    const before = await openApplication(dataDirectory, recognition('XY-V45-LEGACY'));
    const product = before.createStandardProduct({
      sku: 'SKU-V45-LEGACY',
      name: '升级前映射商品',
      specification: '规格',
    });
    const [firstDraft] = (await before.submitRecognitionBatch([firstSource])).drafts;
    before.confirmDraft(firstDraft, undefined, {}, [{
      draftItemId: firstDraft.items[0].id,
      standardProductId: product.id,
      createMapping: true,
    }]);
    closeApplication(before);

    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      legacy.exec(`
        UPDATE product_mappings
        SET scope = 'workspace', platform = NULL, seller_account = NULL;
      `);
      // v47 起建立映射会写变更留痕；模拟真实 v45 数据库前先清除这些留痕。
      legacy.exec(`
        DROP TRIGGER IF EXISTS product_mapping_events_are_immutable_on_update;
        DROP TRIGGER IF EXISTS product_mapping_events_are_immutable_on_delete;
        DELETE FROM product_mapping_events;
      `);
      removeVersion46ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 45 });
      expect((legacy.prepare('PRAGMA table_info(product_mappings)').all() as Array<{
        name: string;
      }>).map(({ name }) => name)).not.toContain('scope');
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare(`
        SELECT scope, platform, seller_account, standard_product_id
        FROM product_mappings
      `).all()).toEqual([{
        scope: 'workspace',
        platform: null,
        seller_account: null,
        standard_product_id: product.id,
      }]);
      expect(migrated.database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type IN ('index', 'trigger') AND tbl_name = 'product_mappings'
        ORDER BY name
      `).all()).toEqual([
        { name: 'product_mappings_by_standard_product' },
        { name: 'product_mappings_one_per_account_source' },
        { name: 'product_mappings_one_per_platform_source' },
        { name: 'product_mappings_one_per_workspace_source' },
        { name: 'sqlite_autoindex_product_mappings_1' },
      ]);
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      migrated.close();
    }

    const constraints = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('check-invalid-scope', '标题', '', '标题', '', ?, 'account_wide',
          NULL, NULL, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(product.id)).toThrow(/CHECK/u);
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('check-account-missing-platform', '标题', '', '标题', '', ?,
          'current_account', NULL, '账号', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(product.id)).toThrow(/CHECK/u);
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('check-platform-with-account', '标题', '', '标题', '', ?,
          'current_platform', 'xianyu', '账号', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(product.id)).toThrow(/CHECK/u);
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('check-workspace-with-platform', '标题', '', '标题', '', ?,
          'workspace', 'xianyu', NULL, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(product.id)).toThrow(/CHECK/u);
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('duplicate-workspace', '标题2', '', ?, ?, ?,
          'workspace', NULL, NULL, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')
      `).run(
        normalizeProductText('古风娃鞋白模-闲鱼专拍'),
        normalizeProductText('05M'),
        product.id,
      )).toThrow(/UNIQUE/u);
      constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('narrower-scope-allowed', '标题2', '', ?, ?, ?,
          'current_account', 'xianyu', '映射账号丁', '2026-08-15T00:00:00.000Z',
          '2026-08-15T00:00:00.000Z')
      `).run(
        normalizeProductText('古风娃鞋白模-闲鱼专拍'),
        normalizeProductText('05M'),
        product.id,
      );
      expect(() => constraints.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, created_at, updated_at
        ) VALUES ('duplicate-account', '标题3', '', ?, ?, ?,
          'current_account', 'xianyu', '映射账号丁', '2026-08-15T00:00:00.000Z',
          '2026-08-15T00:00:00.000Z')
      `).run(
        normalizeProductText('古风娃鞋白模-闲鱼专拍'),
        normalizeProductText('05M'),
        product.id,
      )).toThrow(/UNIQUE/u);
    } finally {
      constraints.close();
    }

    // 存量工作区级映射对任意账号继续命中，升级前后匹配行为不变。
    const after = await openApplication(
      dataDirectory,
      recognition('XY-V45-AFTER', { sellerAccount: '全新账号' }),
    );
    const afterSource = join(root, '升级后.png');
    await writeFile(afterSource, Buffer.from('mapping-v45-after'));
    const [afterDraft] = (await after.submitRecognitionBatch([afterSource])).drafts;
    expect(after.previewDraftProductStandardizations(afterDraft)[0]).toMatchObject({
      automaticProduct: { id: product.id },
      automaticSource: 'mapping',
      automaticMappingScope: 'workspace',
    });
    expect(after.confirmDraft(afterDraft).items[0]).toMatchObject({
      standardProduct: { id: product.id },
      standardizationSource: 'mapping',
    });
    closeApplication(after);

    // 迁移幂等：再次打开不重复执行且不报错。
    const reopened = Workspace.open(dataDirectory);
    try {
      expect(reopened.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 60 });
      expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});
