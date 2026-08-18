import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { PresaleDemandView } from '../src/core/fulfillment-demand';
import type {
  FulfillmentPlanProgressView,
  FulfillmentPlanView,
} from '../src/core/fulfillment-plans';
import type { ShipmentConfirmationResult } from '../src/core/shipment-records';
import type { ShipmentGroupProjection } from '../src/core/shipment-groups';
import type { OrderWorkbenchResult } from '../src/core/order-workbench';
import type { OrderDetails, OrderSummary } from '../src/core/contracts';
import { shanghaiYYMM } from '../src/core/readable-order-numbers';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';
import { Workspace } from '../src/main/workspace';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return { isDestroyed: () => false }; }
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

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

const sessions: DesktopSession[] = [];

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('履约计划 Electron IPC', () => {
  it('未释放订单被闸门拦截，释放或关闭后恢复，重启后计划与归属保持一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plans-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourceA = join(root, '预售订单.png');
    const sourceB = join(root, '团购订单.png');
    await writeFile(sourceA, Buffer.from('fulfillment-plans-ipc-source-a'));
    await writeFile(sourceB, Buffer.from('fulfillment-plans-ipc-source-b'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0001', 1),
      recognition('XY-PLAN-IPC-0002', 2),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA, sourceB])).drafts;
    const orderA = seeder.confirmDraft(drafts[0]);
    const orderB = seeder.confirmDraft(drafts[1]);
    seeder.close();

    const session = openSession(root, dataDirectory);

    const initialGroups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    expect(initialGroups.groups.flatMap((group) => group.orders.map(({ id }) => id)))
      .toEqual(expect.arrayContaining([orderA.id, orderB.id]));

    const presale = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '八月预售',
      expectedShipAt: '2026-09-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    expect(presale).toMatchObject({ status: 'pending', activeOrderCount: 0 });

    const withMember = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [orderA.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    expect(withMember).toMatchObject({ activeOrderCount: 1, activeItemQuantity: 1 });

    const gatedGroups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    const gatedIds = gatedGroups.groups.flatMap((group) => group.orders.map(({ id }) => id));
    expect(gatedIds).not.toContain(orderA.id);
    expect(gatedIds).toContain(orderB.id);
    const pendingExport = await invoke('orders:query', {
      fulfillmentStatus: 'pending_shipment',
    }) as OrderWorkbenchResult;
    const pendingIds = pendingExport.orders.map(({ id }) => id);
    expect(pendingIds).not.toContain(orderA.id);
    expect(pendingIds).toContain(orderB.id);

    const groupBuy = await invoke('fulfillment-plans:create', {
      type: 'group_buy',
      name: '团购批次A',
      targetQuantity: 5,
      deadlineAt: '2026-08-31T00:00:00.000Z',
      reason: '开团',
    }) as FulfillmentPlanView;
    await expect(invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [orderA.id],
      reason: '重复加入',
    })).rejects.toThrow('订单已归属其他未释放履约计划');
    await expect(invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [orderB.id],
      reason: ' ',
    })).rejects.toThrow('请填写非空原因');
    await invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [orderB.id],
      reason: '加入团购',
    });

    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);

    const plansAfterRestart = await invoke('fulfillment-plans:query') as FulfillmentPlanView[];
    expect(plansAfterRestart).toHaveLength(2);
    const presaleAfterRestart = plansAfterRestart.find(({ id }) => id === presale.id);
    expect(presaleAfterRestart).toMatchObject({
      status: 'pending',
      members: [expect.objectContaining({
        orderId: orderA.id,
        joinReason: '加入预售',
        releasedAt: null,
        removedAt: null,
      })],
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: 'created', reason: '预售开始备货' }),
        expect.objectContaining({ eventType: 'orders_added', reason: '加入预售' }),
      ]),
    });
    const groupsAfterRestart = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    expect(groupsAfterRestart.groups.flatMap((group) => group.orders.map(({ id }) => id)))
      .toEqual([]);

    const released = await invoke('fulfillment-plans:release-orders', {
      planId: presale.id,
      expectedRevision: presaleAfterRestart?.revision,
      orderIds: [orderA.id],
      reason: '到货可发',
    }) as FulfillmentPlanView;
    expect(released).toMatchObject({ status: 'released', releasedOrderCount: 1 });
    const postReleaseGroups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    const postReleaseIds = postReleaseGroups.groups
      .flatMap((group) => group.orders.map(({ id }) => id));
    expect(postReleaseIds).toContain(orderA.id);
    expect(postReleaseIds).not.toContain(orderB.id);

    const groupBuyAfterRestart = plansAfterRestart.find(({ id }) => id === groupBuy.id);
    const closed = await invoke('fulfillment-plans:close', {
      planId: groupBuy.id,
      expectedRevision: groupBuyAfterRestart?.revision,
      reason: '未成团关闭',
    }) as FulfillmentPlanView;
    expect(closed).toMatchObject({ status: 'closed', activeOrderCount: 0 });
    expect(closed.members[0]).toMatchObject({
      orderId: orderB.id,
      removedReason: '未成团关闭',
    });
    const finalGroups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    expect(finalGroups.groups.flatMap((group) => group.orders.map(({ id }) => id)))
      .toEqual(expect.arrayContaining([orderA.id, orderB.id]));

    const finalPlans = await invoke('fulfillment-plans:query') as FulfillmentPlanView[];
    const finalPresale = finalPlans.find(({ id }) => id === presale.id);
    expect(finalPresale?.events.map(({ eventType }) => eventType)).toEqual([
      'created',
      'orders_added',
      'orders_released',
    ]);
  });

  it('退出订单恢复现货资格并记录原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plans-remove-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '预售退出订单.png');
    await writeFile(sourcePath, Buffer.from('fulfillment-plans-remove-source'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0003', 1),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    openSession(root, dataDirectory);
    const plan = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '九月预售',
      expectedShipAt: '2026-10-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const withMember = await invoke('fulfillment-plans:add-orders', {
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    const removed = await invoke('fulfillment-plans:remove-order', {
      planId: plan.id,
      expectedRevision: withMember.revision,
      orderId: order.id,
      reason: '买家取消预售',
    }) as FulfillmentPlanView;
    expect(removed).toMatchObject({ activeOrderCount: 0 });
    expect(removed.members[0]).toMatchObject({
      orderId: order.id,
      removedReason: '买家取消预售',
    });
    expect(removed.events.map(({ eventType }) => eventType)).toEqual([
      'created',
      'orders_added',
      'order_removed',
    ]);
    const groups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    expect(groups.groups.flatMap((group) => group.orders.map(({ id }) => id)))
      .toContain(order.id);
  });

  it('释放过的订单终身不能再加入履约计划，也不再出现在加入候选中', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plans-released-gate-'));
    const dataDirectory = join(root, '数据');
    const sourceA = join(root, '预售订单.png');
    const sourceB = join(root, '现货订单.png');
    await writeFile(sourceA, Buffer.from('fulfillment-plans-released-gate-a'));
    await writeFile(sourceB, Buffer.from('fulfillment-plans-released-gate-b'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0101', 1),
      recognition('XY-PLAN-IPC-0102', 1),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA, sourceB])).drafts;
    const orderA = seeder.confirmDraft(drafts[0]);
    const orderB = seeder.confirmDraft(drafts[1]);
    seeder.close();

    openSession(root, dataDirectory);
    const presale = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '十月预售',
      expectedShipAt: '2026-11-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const withMember = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [orderA.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;

    const candidatesBefore = await invoke(
      'fulfillment-plans:order-candidates',
    ) as OrderSummary[];
    expect(candidatesBefore.map(({ id }) => id)).toEqual([orderB.id]);

    await invoke('fulfillment-plans:release-orders', {
      planId: presale.id,
      expectedRevision: withMember.revision,
      orderIds: [orderA.id],
      reason: '到货可发',
    });

    const candidatesAfterRelease = await invoke(
      'fulfillment-plans:order-candidates',
    ) as OrderSummary[];
    expect(candidatesAfterRelease.map(({ id }) => id)).toEqual([orderB.id]);

    const groupBuy = await invoke('fulfillment-plans:create', {
      type: 'group_buy',
      name: '团购批次B',
      targetQuantity: 3,
      reason: '开团',
    }) as FulfillmentPlanView;
    await expect(invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [orderA.id],
      reason: '释放后重新加入',
    })).rejects.toThrow('订单已被履约计划释放，不能再加入新计划');
    const joined = await invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [orderB.id],
      reason: '加入团购',
    }) as FulfillmentPlanView;
    expect(joined.activeOrderCount).toBe(1);
    await expect(invoke('fulfillment-plans:add-orders', {
      planId: groupBuy.id,
      expectedRevision: joined.revision,
      orderIds: [orderB.id],
      reason: '重复加入',
    })).rejects.toThrow('订单已在该履约计划中');
  });

  it('退出的订单不产生归因，可以重新加入其他履约计划', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plans-rejoin-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '退出重加入订单.png');
    await writeFile(sourcePath, Buffer.from('fulfillment-plans-rejoin-source'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0103', 1),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    openSession(root, dataDirectory);
    const first = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '十一月预售',
      expectedShipAt: '2026-12-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const withMember = await invoke('fulfillment-plans:add-orders', {
      planId: first.id,
      expectedRevision: first.revision,
      orderIds: [order.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    await invoke('fulfillment-plans:remove-order', {
      planId: first.id,
      expectedRevision: withMember.revision,
      orderId: order.id,
      reason: '买家改主意退出',
    });

    const candidates = await invoke('fulfillment-plans:order-candidates') as OrderSummary[];
    expect(candidates.map(({ id }) => id)).toEqual([order.id]);
    const progress = await invoke(
      'fulfillment-plans:progress',
      first.id,
    ) as FulfillmentPlanProgressView;
    expect(progress.orders).toEqual([]);

    const second = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '十二月预售',
      expectedShipAt: '2027-01-01T00:00:00.000Z',
      reason: '新一批预售',
    }) as FulfillmentPlanView;
    const rejoined = await invoke('fulfillment-plans:add-orders', {
      planId: second.id,
      expectedRevision: second.revision,
      orderIds: [order.id],
      reason: '退出后重新加入',
    }) as FulfillmentPlanView;
    expect(rejoined).toMatchObject({ activeOrderCount: 1 });
  });

  it('履约进展只归因已释放订单的发货事实，作废后移除，重启保持一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plans-progress-'));
    const dataDirectory = join(root, '数据');
    const sourceA = join(root, '预售订单.png');
    const sourceB = join(root, '现货订单.png');
    await writeFile(sourceA, Buffer.from('fulfillment-plans-progress-a'));
    await writeFile(sourceB, Buffer.from('fulfillment-plans-progress-b'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0201', 2, '预售商品甲'),
      recognition('XY-PLAN-IPC-0202', 1, '现货商品乙'),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA, sourceB])).drafts;
    const orderA = seeder.confirmDraft(drafts[0]);
    const orderB = seeder.confirmDraft(drafts[1]);
    seeder.close();

    const session = openSession(root, dataDirectory);
    const presale = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '腊月预售',
      expectedShipAt: '2027-02-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const withMember = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [orderA.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    await invoke('fulfillment-plans:release-orders', {
      planId: presale.id,
      expectedRevision: withMember.revision,
      orderIds: [orderA.id],
      reason: '到货可发',
    });

    const beforeShip = await invoke(
      'fulfillment-plans:progress',
      presale.id,
    ) as FulfillmentPlanProgressView;
    expect(beforeShip.planId).toBe(presale.id);
    expect(beforeShip.orders).toHaveLength(1);
    expect(beforeShip.orders[0]).toMatchObject({
      orderId: orderA.id,
      systemOrderNumber: orderA.systemOrderNumber,
      buyerNickname: '测试买家',
      releasedReason: '到货可发',
      items: [{ sourceTitle: '预售商品甲', sourceSpec: '标准款', quantity: 2 }],
      shipments: [],
    });

    const groups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    const group = groups.groups.find(({ orders }) => (
      orders.some(({ id }) => id === orderA.id)
    ));
    if (!group) throw new Error('未找到包含已释放订单的发货组');
    expect(group.orders.map(({ id }) => id).sort()).toEqual([orderA.id, orderB.id].sort());
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = await invoke('shipment-records:confirm', {
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-PLAN-PROGRESS-001',
        items: remainingItems,
      }],
    }) as ShipmentConfirmationResult;

    const afterShip = await invoke(
      'fulfillment-plans:progress',
      presale.id,
    ) as FulfillmentPlanProgressView;
    expect(afterShip.orders).toHaveLength(1);
    expect(afterShip.orders[0].shipments).toHaveLength(1);
    expect(afterShip.orders[0].shipments[0]).toMatchObject({
      recordId: shipment.record.id,
      createdAt: shipment.record.createdAt,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-PLAN-PROGRESS-001',
        logisticsStatus: 'in_transit',
        items: [{ sourceTitle: '预售商品甲', sourceSpec: '标准款', quantity: 2 }],
      }],
    });

    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);
    const afterRestart = await invoke(
      'fulfillment-plans:progress',
      presale.id,
    ) as FulfillmentPlanProgressView;
    expect(afterRestart).toEqual(afterShip);

    await invoke('shipment-records:cancel-packages', {
      recordId: shipment.record.id,
      packageIds: [shipment.record.packages[0].id],
      reason: '面单错误整单作废',
    });
    const afterVoid = await invoke(
      'fulfillment-plans:progress',
      presale.id,
    ) as FulfillmentPlanProgressView;
    expect(afterVoid.orders).toHaveLength(1);
    expect(afterVoid.orders[0].shipments).toEqual([]);
    const candidates = await invoke(
      'fulfillment-plans:order-candidates',
    ) as OrderSummary[];
    expect(candidates.map(({ id }) => id)).toEqual([orderB.id]);
  });

  it('订单详情从计划事实派生归属历史与当前归属状态，重启后一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-plan-order-view-'));
    const dataDirectory = join(root, '数据');
    const sourceA = join(root, '计划订单.png');
    const sourceB = join(root, '现货订单.png');
    const sourceC = join(root, '退出订单.png');
    await writeFile(sourceA, Buffer.from('fulfillment-plan-order-view-a'));
    await writeFile(sourceB, Buffer.from('fulfillment-plan-order-view-b'));
    await writeFile(sourceC, Buffer.from('fulfillment-plan-order-view-c'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0301', 1),
      recognition('XY-PLAN-IPC-0302', 1),
      recognition('XY-PLAN-IPC-0303', 1),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA, sourceB, sourceC])).drafts;
    const orderA = seeder.confirmDraft(drafts[0]);
    const orderB = seeder.confirmDraft(drafts[1]);
    const orderC = seeder.confirmDraft(drafts[2]);
    seeder.close();

    const session = openSession(root, dataDirectory);
    const presale = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '仲秋预售',
      expectedShipAt: '2027-03-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const withA = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [orderA.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    const withC = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: withA.revision,
      orderIds: [orderC.id],
      reason: '一起备货',
    }) as FulfillmentPlanView;

    const detailsA = await invoke('orders:get', orderA.id) as OrderDetails;
    expect(detailsA.operations.fulfillmentPlanAttribution).toEqual({
      status: 'active',
      planId: presale.id,
      planType: 'presale',
      planName: '仲秋预售',
    });
    const joinedEntries = detailsA.operations.history.filter(({ kind }) => (
      kind === 'fulfillment_plan'
    ));
    expect(joinedEntries).toHaveLength(1);
    expect(joinedEntries[0]).toMatchObject({
      title: '加入履约计划',
      detail: '仲秋预售 · 加入预售',
    });

    const removed = await invoke('fulfillment-plans:remove-order', {
      planId: presale.id,
      expectedRevision: withC.revision,
      orderId: orderC.id,
      reason: '买家取消预售',
    }) as FulfillmentPlanView;
    const detailsC = await invoke('orders:get', orderC.id) as OrderDetails;
    expect(detailsC.operations.fulfillmentPlanAttribution).toEqual({ status: 'none' });
    const removedEntries = detailsC.operations.history.filter(({ kind }) => (
      kind === 'fulfillment_plan'
    ));
    expect(removedEntries.map(({ title }) => title).sort())
      .toEqual(['加入履约计划', '退出履约计划']);
    expect(removedEntries.find(({ title }) => title === '退出履约计划'))
      .toMatchObject({ detail: '仲秋预售 · 买家取消预售' });

    await invoke('fulfillment-plans:release-orders', {
      planId: presale.id,
      expectedRevision: removed.revision,
      orderIds: [orderA.id],
      reason: '到货可发',
    });
    const releasedDetailsA = await invoke('orders:get', orderA.id) as OrderDetails;
    expect(releasedDetailsA.operations.fulfillmentPlanAttribution).toEqual({
      status: 'released',
      planId: presale.id,
      planType: 'presale',
      planName: '仲秋预售',
    });
    const releasedEntries = releasedDetailsA.operations.history.filter(({ kind }) => (
      kind === 'fulfillment_plan'
    ));
    expect(releasedEntries.map(({ title }) => title).sort())
      .toEqual(['加入履约计划', '被履约计划释放']);
    const releaseEntry = releasedEntries.find(({ title }) => title === '被履约计划释放');
    expect(releaseEntry).toMatchObject({ detail: '仲秋预售 · 到货可发' });
    const joinEntry = releasedEntries.find(({ title }) => title === '加入履约计划');
    expect(Date.parse(releaseEntry?.occurredAt ?? ''))
      .toBeGreaterThanOrEqual(Date.parse(joinEntry?.occurredAt ?? ''));

    const detailsB = await invoke('orders:get', orderB.id) as OrderDetails;
    expect(detailsB.operations.fulfillmentPlanAttribution).toEqual({ status: 'none' });
    expect(detailsB.operations.history.filter(({ kind }) => kind === 'fulfillment_plan'))
      .toEqual([]);

    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);
    const afterRestart = await invoke('orders:get', orderA.id) as OrderDetails;
    expect(afterRestart.operations.fulfillmentPlanAttribution)
      .toEqual(releasedDetailsA.operations.fulfillmentPlanAttribution);
    expect(afterRestart.operations.history.filter(({ kind }) => kind === 'fulfillment_plan'))
      .toEqual(releasedEntries);
  });

  it('可读编号随计划归属实时切换，已关闭计划仍占批次，重启一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-readable-numbers-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourceA = join(root, '订单A.png');
    const sourceB = join(root, '订单B.png');
    const sourceC = join(root, '订单C.png');
    await writeFile(sourceA, Buffer.from('readable-numbers-a'));
    await writeFile(sourceB, Buffer.from('readable-numbers-b'));
    await writeFile(sourceC, Buffer.from('readable-numbers-c'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-PLAN-IPC-0401', 1),
      recognition('XY-PLAN-IPC-0402', 1),
      recognition('XY-PLAN-IPC-0403', 1),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA, sourceB, sourceC])).drafts;
    const orderA = seeder.confirmDraft(drafts[0]);
    const orderB = seeder.confirmDraft(drafts[1]);
    const orderC = seeder.confirmDraft(drafts[2]);
    seeder.close();

    // 固定入库时间，避免同毫秒创建导致次序依赖 id 兜底
    const backdated = Workspace.open(dataDirectory);
    try {
      const update = backdated.database.prepare(
        'UPDATE original_orders SET created_at = ? WHERE id = ?',
      );
      update.run('2026-08-05T01:00:00.000Z', orderA.id);
      update.run('2026-08-05T02:00:00.000Z', orderB.id);
      update.run('2026-08-05T03:00:00.000Z', orderC.id);
    } finally {
      backdated.close();
    }

    const session = openSession(root, dataDirectory);
    const yymm = shanghaiYYMM('2026-08-05T01:00:00.000Z');
    const spotNumbers = await invoke('orders:readable-numbers', [
      orderA.id,
      orderB.id,
      orderC.id,
    ]) as Record<string, string | null>;
    expect(spotNumbers).toEqual({
      [orderA.id]: `${yymm}01-001-PT`,
      [orderB.id]: `${yymm}02-001-PT`,
      [orderC.id]: `${yymm}03-001-PT`,
    });

    const presale = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '白露预售',
      expectedShipAt: '2027-04-01T00:00:00.000Z',
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    const planYymm = shanghaiYYMM(presale.createdAt);
    const withA = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [orderA.id],
      reason: '加入预售',
    }) as FulfillmentPlanView;
    const joinedNumbers = await invoke('orders:readable-numbers', [orderA.id]) as Record<
      string,
      string | null
    >;
    expect(joinedNumbers[orderA.id]).toBe(`${planYymm}01-001-PL`);
    const detailsA = await invoke('orders:get', orderA.id) as OrderDetails;
    expect(detailsA.readableOrderNumber).toBe(`${planYymm}01-001-PL`);

    const withC = await invoke('fulfillment-plans:add-orders', {
      planId: presale.id,
      expectedRevision: withA.revision,
      orderIds: [orderC.id],
      reason: '一起备货',
    }) as FulfillmentPlanView;
    const removed = await invoke('fulfillment-plans:remove-order', {
      planId: presale.id,
      expectedRevision: withC.revision,
      orderId: orderC.id,
      reason: '买家改主意',
    }) as FulfillmentPlanView;
    const exitedNumbers = await invoke('orders:readable-numbers', [orderC.id]) as Record<
      string,
      string | null
    >;
    expect(exitedNumbers[orderC.id]).toBe(`${yymm}03-001-PT`);

    await invoke('fulfillment-plans:release-orders', {
      planId: presale.id,
      expectedRevision: removed.revision,
      orderIds: [orderA.id],
      reason: '到货可发',
    });
    const releasedNumbers = await invoke('orders:readable-numbers', [orderA.id]) as Record<
      string,
      string | null
    >;
    expect(releasedNumbers[orderA.id]).toBe(`${planYymm}01-001-PL`);

    const secondPlan = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '秋分预售',
      expectedShipAt: '2027-05-01T00:00:00.000Z',
      reason: '第二批预售',
    }) as FulfillmentPlanView;
    const secondPlanYymm = shanghaiYYMM(secondPlan.createdAt);
    await invoke('fulfillment-plans:add-orders', {
      planId: secondPlan.id,
      expectedRevision: secondPlan.revision,
      orderIds: [orderC.id],
      reason: '加入第二批',
    });
    const secondPlanNumbers = await invoke('orders:readable-numbers', [orderC.id]) as Record<
      string,
      string | null
    >;
    expect(secondPlanNumbers[orderC.id]).toBe(`${secondPlanYymm}02-001-PL`);

    const presaleNow = (await invoke('fulfillment-plans:query') as FulfillmentPlanView[])
      .find(({ id }) => id === presale.id);
    await invoke('fulfillment-plans:close', {
      planId: presale.id,
      expectedRevision: presaleNow?.revision,
      reason: '全部释放后关闭',
    });
    const thirdPlan = await invoke('fulfillment-plans:create', {
      type: 'group_buy',
      name: '寒露团购',
      targetQuantity: 2,
      reason: '开团',
    }) as FulfillmentPlanView;
    const thirdPlanYymm = shanghaiYYMM(thirdPlan.createdAt);
    await invoke('fulfillment-plans:add-orders', {
      planId: thirdPlan.id,
      expectedRevision: thirdPlan.revision,
      orderIds: [orderB.id],
      reason: '加入团购',
    });
    const thirdPlanNumbers = await invoke('orders:readable-numbers', [orderB.id]) as Record<
      string,
      string | null
    >;
    expect(thirdPlanNumbers[orderB.id]).toBe(`${thirdPlanYymm}03-001-PL`);

    const beforeRestart = await invoke('orders:readable-numbers', [
      orderA.id,
      orderB.id,
      orderC.id,
    ]) as Record<string, string | null>;
    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);
    expect(await invoke('orders:readable-numbers', [orderA.id, orderB.id, orderC.id]))
      .toEqual(beforeRestart);
  });
});

describe('预售需求与采购建议 Electron IPC', () => {
  it('需求投影、发货前退款与建议生命周期跨 IPC 生效并重启保持', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '预售需求订单.png');
    await writeFile(sourcePath, Buffer.from('demand-ipc-source'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-DEMAND-IPC-0001', 10, '玻璃保鲜盒'),
    ]));
    seeder.openDataDirectory(dataDirectory);
    seeder.createStandardProduct({
      sku: 'SKU-DEMAND-IPC',
      name: '玻璃保鲜盒',
      specification: '标准款',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    const session = openSession(root, dataDirectory);
    const plan = await invoke('fulfillment-plans:create', {
      type: 'presale',
      name: '八月预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      demandAlertThreshold: 5,
      reason: '预售开始备货',
    }) as FulfillmentPlanView;
    await invoke('fulfillment-plans:add-orders', {
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });

    const demand = await invoke('fulfillment-plans:demand', plan.id) as PresaleDemandView;
    expect(demand.totals).toMatchObject({ demandQuantity: 10, uncoveredQuantity: 10 });
    expect(demand.demandAlertThreshold).toBe(5);
    expect(demand.unmapped).toEqual([]);

    const productId = demand.products[0].standardProductId;
    const drafted = await invoke('fulfillment-plans:create-purchase-suggestion', {
      planId: plan.id,
      standardProductId: productId,
      quantity: 4,
      reason: '第1批采购',
    }) as PresaleDemandView;
    const draftSuggestion = drafted.suggestions[0];
    expect(draftSuggestion).toMatchObject({ status: 'draft', quantity: 4 });

    const confirmed = await invoke(
      'fulfillment-plans:confirm-purchase-suggestion',
      {
        planId: plan.id,
        suggestionId: draftSuggestion.id,
        reason: '确认第1批',
      },
    ) as PresaleDemandView;
    expect(confirmed.products[0]).toMatchObject({
      confirmedInTransitQuantity: 4,
      uncoveredQuantity: 6,
    });

    const afterRefund = await invoke('fulfillment-plans:register-refund', {
      planId: plan.id,
      orderId: order.id,
      orderItemId: order.items[0].id,
      quantity: 2,
      reason: '买家退回2件',
    }) as PresaleDemandView;
    expect(afterRefund.products[0]).toMatchObject({
      demandQuantity: 8,
      refundedOrCancelledQuantity: 2,
      confirmedInTransitQuantity: 4,
      uncoveredQuantity: 4,
    });

    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);
    const persisted = await invoke('fulfillment-plans:demand', plan.id) as PresaleDemandView;
    expect(persisted.totals).toMatchObject({
      demandQuantity: 8,
      refundedOrCancelledQuantity: 2,
      confirmedInTransitQuantity: 4,
    });
    expect(persisted.suggestions[0]).toMatchObject({
      status: 'confirmed',
      quantity: 4,
    });
  });
});

function openSession(root: string, dataDirectory: string): DesktopSession {
  const session = new DesktopSession(
    new Preferences(join(root, '启动配置')),
    new SequenceRecognizer([]),
    unusedOcrSettings,
  );
  sessions.push(session);
  session.useDataDirectory(dataDirectory);
  registerIpcHandlers(session);
  return session;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function recognition(
  orderNumber: string,
  quantity: number,
  sourceTitle = '测试商品',
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
    productTotalCents: 800 * quantity,
    shippingFeeCents: 0,
    amountCents: 800 * quantity,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle,
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity,
      quantityInferred: false,
    }],
  };
}

const unusedOcrSettings = new OcrSettingsService(
  { read: () => null, write: () => undefined },
  {
    getApiKey: async () => null,
    setApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
    getDisplayName: () => '测试系统凭据库',
  },
  { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
);
