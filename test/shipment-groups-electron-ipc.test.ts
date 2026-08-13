import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

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

const sessions: DesktopSession[] = [];

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('发货组 Electron IPC', () => {
  it('通过只读通道返回本机动态发货组投影', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-groups-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('shipment-groups-ipc-source'));
    const recognition = completeRecognition();
    const seeder = new LocalApplication(new ControlledRecognizer(recognition));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      new ControlledRecognizer(recognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    registerIpcHandlers(session);

    await expect(invoke('shipment-groups:query')).resolves.toMatchObject({
      groups: [{
        orderCount: 1,
        totalQuantity: 1,
        totalAmountCents: 800,
        orders: [{ id: order.id, orderNumber: order.orderNumber }],
      }],
      attentionOrders: [],
    });
  });

  it('通过受控通道传递拆分与重组命令', async () => {
    const splitShipmentGroup = vi.fn().mockReturnValue({ event: { operation: 'split' } });
    const mergeShipmentGroups = vi.fn().mockReturnValue({ event: { operation: 'merge' } });
    registerIpcHandlers({
      splitShipmentGroup,
      mergeShipmentGroups,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const splitInput = {
      groupId: 'group-1',
      expectedMemberOrderIds: ['order-1', 'order-2'],
      splitOrderIds: ['order-2'],
      reason: '单独包装',
    };
    const mergeInput = {
      groupIds: ['group-1', 'group-2'],
      expectedMemberOrderIds: ['order-1', 'order-2'],
      selectedRecipientOrderId: 'order-1',
      reason: '一起发货',
    };

    await expect(invoke('shipment-groups:split', splitInput)).resolves.toMatchObject({
      event: { operation: 'split' },
    });
    await expect(invoke('shipment-groups:merge', mergeInput)).resolves.toMatchObject({
      event: { operation: 'merge' },
    });
    expect(splitShipmentGroup).toHaveBeenCalledWith(splitInput);
    expect(mergeShipmentGroups).toHaveBeenCalledWith(mergeInput);
  });

  it('通过受控通道查询发货组档案并确认实际发货', async () => {
    const queryShipmentGroupArchives = vi.fn().mockReturnValue([{
      id: 'shipment-group-archive-1',
      records: [{ id: 'shipment-record-1' }],
    }]);
    const confirmShipment = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2' },
      projection: { groups: [], attentionOrders: [] },
    });
    registerIpcHandlers({
      queryShipmentGroupArchives,
      confirmShipment,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const input = {
      groupId: 'group-1',
      expectedRemainingItems: [{
        orderId: 'order-1',
        orderItemId: 'item-1',
        quantity: 2,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000010',
        items: [{ orderId: 'order-1', orderItemId: 'item-1', quantity: 2 }],
      }],
    };

    await expect(invoke('shipment-group-archives:query')).resolves.toEqual([
      {
        id: 'shipment-group-archive-1',
        records: [{ id: 'shipment-record-1' }],
      },
    ]);
    await expect(invoke('shipment-records:confirm', input)).resolves.toMatchObject({
      record: { id: 'shipment-record-2' },
    });
    expect(queryShipmentGroupArchives).toHaveBeenCalledTimes(1);
    expect(confirmShipment).toHaveBeenCalledWith(input);
  });

  it('通过受控通道撤销未交寄包裹、更正物流并更新时间线状态', async () => {
    const cancelShipmentPackages = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-1', status: 'voided' },
    });
    const correctShipmentPackageLogistics = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2' },
    });
    const updateShipmentPackageLogisticsStatus = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', logisticsStatus: 'delivered' },
    });
    const progressShipmentPackageCarrierClaim = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', carrierClaimStatus: 'pending' },
    });
    registerIpcHandlers({
      cancelShipmentPackages,
      correctShipmentPackageLogistics,
      updateShipmentPackageLogisticsStatus,
      progressShipmentPackageCarrierClaim,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const cancelInput = {
      recordId: 'shipment-record-1',
      packageIds: ['package-1'],
      reason: '尚未实际交寄',
    };
    const correctionInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 1,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT1000000003',
      reason: '更正录入错误',
    };
    const statusInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 2,
      logisticsStatus: 'delivered',
      reason: '买家确认签收',
    };
    const claimInput = {
      kind: 'open',
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 3,
      requestedAmountCents: 1_000,
      occurredAt: '2026-08-14T09:00:00+08:00',
      reason: '就包裹破损申请索赔',
    };

    await expect(invoke('shipment-records:cancel-packages', cancelInput))
      .resolves.toMatchObject({ record: { status: 'voided' } });
    await expect(invoke('shipment-records:correct-package-logistics', correctionInput))
      .resolves.toMatchObject({ record: { id: 'shipment-record-2' } });
    await expect(invoke('shipment-records:update-package-logistics-status', statusInput))
      .resolves.toMatchObject({ record: { logisticsStatus: 'delivered' } });
    await expect(invoke('shipment-records:progress-package-carrier-claim', claimInput))
      .resolves.toMatchObject({ record: { carrierClaimStatus: 'pending' } });
    expect(cancelShipmentPackages).toHaveBeenCalledWith(cancelInput);
    expect(correctShipmentPackageLogistics).toHaveBeenCalledWith(correctionInput);
    expect(updateShipmentPackageLogisticsStatus).toHaveBeenCalledWith(statusInput);
    expect(progressShipmentPackageCarrierClaim).toHaveBeenCalledWith(claimInput);
  });

  it('通过受控通道建立、更新、推进并查询售后处理单', async () => {
    const created = { id: 'aftersales-1', status: 'processing', revision: 1 };
    const updated = { id: 'aftersales-1', status: 'waiting_return', revision: 2 };
    const createAftersalesCase = vi.fn().mockReturnValue(created);
    const updateAftersalesCase = vi.fn().mockReturnValue(updated);
    const progressed = { id: 'aftersales-1', status: 'ready_to_complete', revision: 3 };
    const progressAftersalesCase = vi.fn().mockReturnValue(progressed);
    const queryAftersalesCases = vi.fn().mockReturnValue([updated]);
    registerIpcHandlers({
      createAftersalesCase,
      updateAftersalesCase,
      progressAftersalesCase,
      queryAftersalesCases,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const createInput = {
      shipmentRecordId: 'shipment-record-1',
      occurredAt: '2026-08-13T10:00:00+08:00',
      reason: '商品破损',
      items: [{ shipmentPackageItemId: 'shipment-item-1', quantity: 1 }],
    };
    const updateInput = {
      caseId: 'aftersales-1',
      expectedRevision: 1,
      status: 'waiting_return',
      reason: '等待买家退回',
      items: [{ shipmentPackageItemId: 'shipment-item-1', quantity: 1 }],
      changeReason: '与买家确认退回处理',
    };
    const query = { status: 'waiting_return' };
    const progressInput = {
      kind: 'confirm_refund',
      caseId: 'aftersales-1',
      expectedRevision: 2,
      actualRefundCents: 500,
      occurredAt: '2026-08-13T10:10:00+08:00',
      note: '平台确认实际退款',
    };

    await expect(invoke('aftersales-cases:create', createInput)).resolves.toEqual(created);
    await expect(invoke('aftersales-cases:update', updateInput)).resolves.toEqual(updated);
    await expect(invoke('aftersales-cases:progress', progressInput)).resolves.toEqual(progressed);
    await expect(invoke('aftersales-cases:query', query)).resolves.toEqual([updated]);
    expect(createAftersalesCase).toHaveBeenCalledWith(createInput);
    expect(updateAftersalesCase).toHaveBeenCalledWith(updateInput);
    expect(progressAftersalesCase).toHaveBeenCalledWith(progressInput);
    expect(queryAftersalesCases).toHaveBeenCalledWith(query);
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function completeRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber: 'XY-SHIPMENT-GROUPS-IPC-0001',
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
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
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
